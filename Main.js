import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const UDP_DISCOVERY_PORT = 45678;
const DEFAULT_WS_PORT = 8080;
const RECONNECT_DELAY_MS = 2500;
const BEACON_STALE_MS = 8000;

const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_PROVISION_CHAR_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const BLE_STATUS_CHAR_UUID = '1c95d5e3-d8db-4373-b650-cfdc93e0e345';

// Optional native UDP module: safely ignored if not compiled into the offline APK
let dgramModule = null;
try {
  dgramModule = require('react-native-udp');
} catch (_err) {
  dgramModule = null;
}

// Optional native BLE module: safely ignored if react-native-ble-plx is not linked
let blePlxModule = null;
try {
  blePlxModule = require('react-native-ble-plx');
} catch (_err) {
  blePlxModule = null;
}

function encodeBase64Utf8(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
        i += 1;
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;

    out += chars[(b0 >> 2) & 0x3f];
    out += chars[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f)];
    out += hasB1 ? chars[((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03)] : '=';
    out += hasB2 ? chars[b2 & 0x3f] : '=';
  }
  return out;
}

function decodeBase64Utf8(b64) {
  if (typeof b64 !== 'string' || !b64.trim()) return '';
  const cleaned = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];

  for (let i = 0; i < cleaned.length; i += 4) {
    const c0 = chars.indexOf(cleaned[i] || 'A');
    const c1 = chars.indexOf(cleaned[i + 1] || 'A');
    const c2 = cleaned[i + 2] === '=' ? -1 : chars.indexOf(cleaned[i + 2] || 'A');
    const c3 = cleaned[i + 3] === '=' ? -1 : chars.indexOf(cleaned[i + 3] || 'A');

    const b0 = (c0 << 2) | (c1 >> 4);
    bytes.push(b0 & 0xff);
    if (c2 !== -1) {
      bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    }
    if (c3 !== -1) {
      bytes.push(((c2 & 0x03) << 6) | c3);
    }
  }

  let result = '';
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  try {
    return decodeURIComponent(escape(result));
  } catch (_err) {
    return result;
  }
}

function normalizeIpv4(rawIp) {
  if (typeof rawIp !== 'string') return null;
  const cleaned = rawIp.trim().replace(/^::ffff:/i, '');
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(cleaned) ? cleaned : null;
}

function normalizeWsPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  const trimmed = rawPath.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildWsUrl(target) {
  const path = normalizeWsPath(target && target.path);
  return `ws://${target.host}:${target.port}${path}`;
}

function parseAgentBeacon(rawMessage, rinfo) {
  const senderIp = rinfo && rinfo.address ? normalizeIpv4(rinfo.address) : null;
  let port = DEFAULT_WS_PORT;
  let path = '';
  let serviceMatched = false;

  try {
    const parsed = JSON.parse(rawMessage);
    if (parsed && typeof parsed === 'object') {
      if (parsed.service === 'pc_telemetry_agent') {
        serviceMatched = true;
      }
      if (typeof parsed.port === 'number' && parsed.port > 0 && parsed.port <= 65535) {
        port = parsed.port;
      }
      if (typeof parsed.path === 'string') {
        path = normalizeWsPath(parsed.path);
      }
      const payloadIp = normalizeIpv4(parsed.ip || parsed.host || '');
      const host = senderIp || payloadIp;
      if (host && (serviceMatched || parsed.service === undefined)) {
        return { host, port, path };
      }
    }
  } catch (_err) {
    const match = String(rawMessage).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (match) {
      const fallbackHost = normalizeIpv4(match[0]);
      if (fallbackHost) {
        return { host: fallbackHost, port: DEFAULT_WS_PORT, path: '' };
      }
    }
  }

  if (senderIp && serviceMatched) {
    return { host: senderIp, port, path };
  }
  return null;
}

function formatRate(kbps) {
  if (typeof kbps !== 'number' || Number.isNaN(kbps)) return '--';
  if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(2)} MB/s`;
  }
  return `${kbps.toFixed(1)} KB/s`;
}

function parsePercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseCharging(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'charging';
  }
  return Boolean(value);
}

function formatBattery(payload) {
  const source =
    payload && typeof payload === 'object'
      ? payload.data && typeof payload.data === 'object'
        ? payload.data
        : payload.telemetry && typeof payload.telemetry === 'object'
        ? payload.telemetry
        : payload
      : {};

  const pctCandidate =
    source?.battery_percent ??
    source?.battery_percentage ??
    source?.batteryPercent ??
    source?.battery;
  const rawPct = parsePercent(pctCandidate);

  const chargingCandidate =
    source?.is_charging ?? source?.charging ?? source?.isCharging;
  const isCharging = parseCharging(chargingCandidate);

  const stateCandidate =
    source?.battery_state ?? source?.batteryState ?? source?.state;
  const rawState =
    typeof stateCandidate === 'string' && stateCandidate.trim()
      ? stateCandidate.trim()
      : '';

  const levelText = rawPct !== null ? `${rawPct.toFixed(1)}%` : '--';

  let detailText = 'On battery';
  if (rawState === 'NoBattery') {
    detailText = 'No battery (AC / Desktop)';
  } else if (rawState === 'Unavailable') {
    detailText = rawPct !== null ? 'State unavailable' : 'Battery unavailable';
  } else if (rawState === 'ReadError') {
    detailText = rawPct !== null ? `${rawState} (last reading)` : 'Battery read error';
  } else if (isCharging) {
    detailText = rawState ? `Charging · ${rawState}` : 'Charging';
  } else if (rawState) {
    detailText = rawPct !== null ? rawState : `${rawState} (no % reading)`;
  } else if (rawPct === null) {
    detailText = 'Awaiting battery data';
  }

  return {
    levelText,
    detailText,
    isCharging,
  };
}

function formatStorage(payload) {
  const source =
    payload && typeof payload === 'object'
      ? payload.data && typeof payload.data === 'object'
        ? payload.data
        : payload.telemetry && typeof payload.telemetry === 'object'
        ? payload.telemetry
        : payload
      : {};

  const rawStorage = source?.storage ?? source?.disk_summary ?? source?.disks;
  if (typeof rawStorage === 'string' && rawStorage.trim()) {
    return rawStorage.trim();
  }
  if (Array.isArray(rawStorage) && rawStorage.length > 0) {
    return rawStorage.map((item) => String(item)).join(' | ');
  }
  return 'Storage unavailable';
}

function formatTelemetry(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      cpu: '--',
      ram: '--',
      memDetail: '-- / -- MB',
      batteryLevel: '--',
      batteryDetail: 'Waiting for battery telemetry...',
      isCharging: false,
      storage: 'Waiting for storage telemetry...',
      netDown: '--',
      netUp: '--',
      activeWindow: 'Waiting for telemetry...',
      updatedAt: new Date().toLocaleTimeString(),
      raw: String(payload ?? ''),
    };
  }

  const cpuRaw = payload.cpu_usage_percent ?? payload.cpu_usage ?? payload.cpu;
  const ramRaw = payload.ram_usage_percent ?? payload.ram_usage ?? payload.ram;
  const usedMb = typeof payload.used_mem_mb === 'number' ? payload.used_mem_mb : null;
  const totalMb = typeof payload.total_mem_mb === 'number' ? payload.total_mem_mb : null;
  const battery = formatBattery(payload);
  const storage = formatStorage(payload);

  const updatedAt =
    typeof payload.timestamp === 'number' && payload.timestamp > 0
      ? new Date(payload.timestamp * 1000).toLocaleTimeString()
      : new Date().toLocaleTimeString();

  return {
    cpu: typeof cpuRaw === 'number' ? `${cpuRaw.toFixed(1)}%` : String(cpuRaw ?? '--'),
    ram: typeof ramRaw === 'number' ? `${ramRaw.toFixed(1)}%` : String(ramRaw ?? '--'),
    memDetail:
      usedMb !== null && totalMb !== null
        ? `${usedMb} / ${totalMb} MB`
        : 'Memory breakdown unavailable',
    batteryLevel: battery.levelText,
    batteryDetail: battery.detailText,
    isCharging: battery.isCharging,
    storage,
    netDown: formatRate(payload.net_down_kbps),
    netUp: formatRate(payload.net_up_kbps),
    activeWindow: String(payload.active_window ?? 'Unknown'),
    updatedAt,
    raw: JSON.stringify(payload, null, 2),
  };
}

export default function App() {
  const hasNativeUdp = Boolean(dgramModule && typeof dgramModule.createSocket === 'function');
  const hasNativeBle = Boolean(blePlxModule && typeof blePlxModule.BleManager === 'function');

  const [discoveryState, setDiscoveryState] = useState(
    hasNativeUdp ? 'Listening' : 'Manual / Direct'
  );
  const [statusMessage, setStatusMessage] = useState(
    hasNativeUdp
      ? `Passive UDP :${UDP_DISCOVERY_PORT} listener active`
      : 'Enter PC LAN IP (e.g. 192.168.0.175 or 192.168.43.x)'
  );
  const [manualHost, setManualHost] = useState('192.168.0.175');
  const [manualPort, setManualPort] = useState(String(DEFAULT_WS_PORT));
  const [manualPath, setManualPath] = useState('');
  const [agentEndpoint, setAgentEndpoint] = useState(null);
  const [wsState, setWsState] = useState('Idle');
  const [lastError, setLastError] = useState('');
  const [paused, setPaused] = useState(false);
  const [showRawJson, setShowRawJson] = useState(true);

  // ESP32-C3 Watch BLE Provisioning State
  const [bleState, setBleState] = useState(hasNativeBle ? 'Ready' : 'BLE Unavailable');
  const [bleStatusText, setBleStatusText] = useState(
    hasNativeBle
      ? 'Scan for ESP32C3-Watch, pair, then push Wi-Fi & PC host in one click'
      : 'Install/link react-native-ble-plx in APK to enable BLE pairing'
  );
  const [bleDeviceName, setBleDeviceName] = useState('');
  const [bleDeviceId, setBleDeviceId] = useState('');
  const [bleScanning, setBleScanning] = useState(false);
  const [blePushing, setBlePushing] = useState(false);
  const [watchWifiSsid, setWatchWifiSsid] = useState('');
  const [watchWifiPass, setWatchWifiPass] = useState('');

  const [telemetry, setTelemetry] = useState({
    cpu: '--',
    ram: '--',
    memDetail: '-- / -- MB',
    batteryLevel: '--',
    batteryDetail: 'No battery telemetry yet',
    isCharging: false,
    storage: 'No storage telemetry yet',
    netDown: '--',
    netUp: '--',
    activeWindow: 'No telemetry received yet',
    updatedAt: '--:--:--',
    raw: '',
  });

  const mountedRef = useRef(true);
  const pausedRef = useRef(false);
  const wsRef = useRef(null);
  const udpRef = useRef(null);
  const bleManagerRef = useRef(null);
  const bleDeviceRef = useRef(null);
  const bleMonitorSubRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const staleBeaconTimerRef = useRef(null);
  const sessionRef = useRef(0);
  const endpointRef = useRef(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (staleBeaconTimerRef.current) {
      clearTimeout(staleBeaconTimerRef.current);
      staleBeaconTimerRef.current = null;
    }
  }, []);

  const closeWebSocket = useCallback((bumpSession = true) => {
    if (bumpSession) {
      sessionRef.current += 1;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const current = wsRef.current;
    wsRef.current = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close();
      } catch (_err) {}
    }
  }, []);

  const cleanupBle = useCallback(async (disconnectDevice = true) => {
    const mgr = bleManagerRef.current;
    if (mgr && typeof mgr.stopDeviceScan === 'function') {
      try {
        mgr.stopDeviceScan();
      } catch (_err) {}
    }
    if (mountedRef.current) {
      setBleScanning(false);
    }

    if (bleMonitorSubRef.current && typeof bleMonitorSubRef.current.remove === 'function') {
      try {
        bleMonitorSubRef.current.remove();
      } catch (_err) {}
    }
    bleMonitorSubRef.current = null;

    const dev = bleDeviceRef.current;
    if (disconnectDevice && dev && mgr && typeof mgr.cancelDeviceConnection === 'function') {
      try {
        await mgr.cancelDeviceConnection(dev.id);
      } catch (_err) {}
    }
    if (disconnectDevice) {
      bleDeviceRef.current = null;
    }
  }, []);

  const requestBlePermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return true;
    const apiLevel = Platform.Version || 31;
    try {
      if (apiLevel >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);
        return (
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
            PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
            PermissionsAndroid.RESULTS.GRANTED
        );
      }
      const locGranted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return locGranted === PermissionsAndroid.RESULTS.GRANTED;
    } catch (_err) {
      return false;
    }
  }, []);

  const handleScanAndPairWatch = useCallback(async () => {
    if (!hasNativeBle) {
      setLastError('BLE module unavailable: add react-native-ble-plx and rebuild APK');
      return;
    }

    const okPerms = await requestBlePermissions();
    if (!okPerms) {
      setLastError('Bluetooth permissions denied on Android');
      return;
    }

    try {
      if (!bleManagerRef.current) {
        bleManagerRef.current = new blePlxModule.BleManager();
      }
      const mgr = bleManagerRef.current;

      await cleanupBle(true);
      setLastError('');
      setBleScanning(true);
      setBleState('Scanning');
      setBleStatusText('Scanning for ESP32C3-Watch over BLE...');

      let foundHandled = false;

      mgr.startDeviceScan([BLE_SERVICE_UUID], { allowDuplicates: false }, async (error, device) => {
        if (error) {
          if (!mountedRef.current) return;
          setBleScanning(false);
          setBleState('Error');
          setBleStatusText('BLE scan failed');
          setLastError(`BLE scan error: ${error.message || 'unknown error'}`);
          return;
        }

        const nameMatch =
          device &&
          ((device.name && device.name.includes('ESP32C3')) ||
            (device.localName && device.localName.includes('ESP32C3')));

        if (device && !foundHandled && nameMatch) {
          foundHandled = true;
          try {
            mgr.stopDeviceScan();
          } catch (_e) {}

          if (!mountedRef.current) return;
          setBleScanning(false);
          setBleState('Pairing');
          const resolvedName = device.localName || device.name || 'ESP32C3-Watch';
          setBleDeviceName(resolvedName);
          setBleDeviceId(device.id);
          setBleStatusText(`Pairing with ${resolvedName}...`);

          try {
            const connected = await mgr.connectToDevice(device.id, { timeout: 12000 });
            const discovered = await connected.discoverAllServicesAndCharacteristics();
            bleDeviceRef.current = discovered;

            if (!mountedRef.current) return;
            setBleState('Paired');
            setBleStatusText(`Paired with ${resolvedName} — ready for 1-click push`);

            bleMonitorSubRef.current = discovered.monitorCharacteristicForService(
              BLE_SERVICE_UUID,
              BLE_STATUS_CHAR_UUID,
              (charErr, characteristic) => {
                if (!mountedRef.current) return;
                if (charErr) {
                  setBleStatusText(`Notify warning: ${charErr.message || 'monitor error'}`);
                  return;
                }
                if (characteristic && characteristic.value) {
                  const decoded = decodeBase64Utf8(characteristic.value);
                  if (decoded) {
                    setBleStatusText(`Watch: ${decoded}`);
                    if (decoded.startsWith('WS_CONNECTED')) {
                      setBleState('On Network');
                    }
                  }
                }
              }
            );
          } catch (connErr) {
            if (!mountedRef.current) return;
            setBleState('Disconnected');
            setBleStatusText('Pairing failed');
            setLastError(
              `BLE connect error: ${connErr && connErr.message ? connErr.message : 'failed'}`
            );
          }
        }
      });

      setTimeout(() => {
        if (!foundHandled && mountedRef.current) {
          try {
            mgr.stopDeviceScan();
          } catch (_e) {}
          setBleScanning(false);
          setBleState((prev) => (prev === 'Scanning' ? 'Idle' : prev));
          setBleStatusText((prev) =>
            prev === 'Scanning for ESP32C3-Watch over BLE...'
              ? 'No ESP32C3-Watch found nearby — ensure firmware is running'
              : prev
          );
        }
      }, 10000);
    } catch (err) {
      if (!mountedRef.current) return;
      setBleScanning(false);
      setBleState('Error');
      setLastError(`BLE init error: ${err && err.message ? err.message : 'failed'}`);
    }
  }, [cleanupBle, hasNativeBle, requestBlePermissions]);

  const handlePushWatchToNetwork = useCallback(async () => {
    if (!hasNativeBle || !bleDeviceRef.current) {
      setLastError('Pair with ESP32C3-Watch over BLE before pushing to network');
      return;
    }

    const trimmedSsid = watchWifiSsid.trim();
    if (!trimmedSsid) {
      setLastError('Enter Wi-Fi SSID for the ESP32-C3 watch');
      return;
    }

    const activeHost =
      (agentEndpoint && agentEndpoint.host) || normalizeIpv4(manualHost) || '';
    const activePort =
      (agentEndpoint && agentEndpoint.port) ||
      parseInt(manualPort, 10) ||
      DEFAULT_WS_PORT;

    const provisionPayload = JSON.stringify({
      ssid: trimmedSsid,
      pass: watchWifiPass,
      ws_host: activeHost,
      ws_port: activePort,
    });

    try {
      setBlePushing(true);
      setLastError('');
      setBleStatusText('Pushing Wi-Fi & telemetry host to watch...');

      const encoded = encodeBase64Utf8(provisionPayload);
      await bleDeviceRef.current.writeCharacteristicWithResponseForService(
        BLE_SERVICE_UUID,
        BLE_PROVISION_CHAR_UUID,
        encoded
      );

      if (!mountedRef.current) return;
      setBlePushing(false);
      setBleState('Pushed');
      setBleStatusText(
        `Pushed "${trimmedSsid}"${activeHost ? ` → WS ${activeHost}:${activePort}` : ''}`
      );
    } catch (err) {
      if (!mountedRef.current) return;
      setBlePushing(false);
      setBleState('Paired');
      setLastError(
        `BLE push failed: ${err && err.message ? err.message : 'write error'}`
      );
    }
  }, [agentEndpoint, hasNativeBle, manualHost, manualPort, watchWifiPass, watchWifiSsid]);

  const handleDisconnectWatchBle = useCallback(async () => {
    await cleanupBle(true);
    if (!mountedRef.current) return;
    setBleDeviceName('');
    setBleDeviceId('');
    setBleState(hasNativeBle ? 'Ready' : 'BLE Unavailable');
    setBleStatusText('Watch BLE disconnected');
  }, [cleanupBle, hasNativeBle]);

  const openWebSocket = useCallback(
    (target, sessionId, force = false) => {
      if (!mountedRef.current || sessionId !== sessionRef.current || !target || pausedRef.current) {
        return;
      }

      const active = wsRef.current;
      if (
        !force &&
        active &&
        (active.readyState === WebSocket.CONNECTING || active.readyState === WebSocket.OPEN)
      ) {
        return;
      }

      closeWebSocket(false);

      const url = buildWsUrl(target);
      let sawErrorDetail = '';

      setWsState('Connecting');
      setStatusMessage(`Connecting to ${url}`);
      setLastError('');

      try {
        const socket = new WebSocket(url);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!mountedRef.current || sessionId !== sessionRef.current) return;
          sawErrorDetail = '';
          setWsState('Connected');
          setStatusMessage(`Streaming live from ${url}`);
          setLastError('');
        };

        socket.onmessage = (event) => {
          if (!mountedRef.current || sessionId !== sessionRef.current || pausedRef.current) return;
          try {
            const parsed = JSON.parse(event.data);
            setTelemetry(formatTelemetry(parsed));
          } catch (_err) {
            setTelemetry((prev) => ({
              ...prev,
              activeWindow: String(event.data || ''),
              updatedAt: new Date().toLocaleTimeString(),
              raw: String(event.data || ''),
            }));
          }
        };

        socket.onerror = (event) => {
          if (!mountedRef.current || sessionId !== sessionRef.current) return;
          const detail =
            event && typeof event.message === 'string' && event.message.trim()
              ? event.message.trim()
              : 'Socket handshake/connection failed (check cleartext WS / LAN reachability)';
          sawErrorDetail = detail;
          console.log('[WS ERROR]', url, detail, event);
          setLastError(`WS error (${url}): ${detail}`);
        };

        socket.onclose = (event) => {
          if (!mountedRef.current || sessionId !== sessionRef.current) return;
          if (wsRef.current === socket) {
            wsRef.current = null;
          }

          const code = event && typeof event.code === 'number' ? event.code : 0;
          const reason =
            event && typeof event.reason === 'string' && event.reason.trim()
              ? ` — ${event.reason.trim()}`
              : '';
          console.log('[WS CLOSE]', url, 'code=', code, 'reason=', reason);

          if (pausedRef.current) {
            setWsState('Idle');
            return;
          }

          if (!sawErrorDetail && code && code !== 1000) {
            setLastError(`Closed (${code}${reason}) on ${url}`);
          }

          setWsState('Reconnecting');
          setStatusMessage(
            `Link dropped${code ? ` [${code}]` : ''} — retrying ${url} in ${RECONNECT_DELAY_MS / 1000}s`
          );

          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
          }
          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current && sessionId === sessionRef.current && !pausedRef.current) {
              openWebSocket(target, sessionId, true);
            }
          }, RECONNECT_DELAY_MS);
        };
      } catch (err) {
        if (!mountedRef.current || sessionId !== sessionRef.current) return;
        const msg = err && err.message ? err.message : 'Unable to initialize WebSocket';
        console.log('[WS INIT ERROR]', url, msg, err);
        setWsState('Reconnecting');
        setLastError(msg);
      }
    },
    [closeWebSocket]
  );

  const armStaleBeaconWatchdog = useCallback(() => {
    if (staleBeaconTimerRef.current) {
      clearTimeout(staleBeaconTimerRef.current);
    }
    staleBeaconTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setDiscoveryState('Listening');
    }, BEACON_STALE_MS);
  }, []);

  const bindUdpListener = useCallback(() => {
    const existing = udpRef.current;
    udpRef.current = null;
    if (existing) {
      try {
        if (typeof existing.removeAllListeners === 'function') {
          existing.removeAllListeners();
        }
      } catch (_e) {}
      try {
        existing.close();
      } catch (_e) {}
    }

    if (!hasNativeUdp) {
      if (mountedRef.current) {
        setDiscoveryState('Direct WS');
      }
      return;
    }

    try {
      const udp = dgramModule.createSocket({ type: 'udp4', reusePort: true });
      udpRef.current = udp;

      udp.on('message', (msg, rinfo) => {
        if (!mountedRef.current || udpRef.current !== udp) return;
        const rawText = typeof msg === 'string' ? msg : msg.toString('utf8');
        const beacon = parseAgentBeacon(rawText, rinfo);
        if (!beacon) return;

        armStaleBeaconWatchdog();
        setDiscoveryState('Discovered');
        setManualHost(beacon.host);
        setManualPort(String(beacon.port));
        if (beacon.path) {
          setManualPath(beacon.path);
        }

        const prev = endpointRef.current;
        const changed =
          !prev ||
          prev.host !== beacon.host ||
          prev.port !== beacon.port ||
          normalizeWsPath(prev.path) !== normalizeWsPath(beacon.path);

        if (changed) {
          endpointRef.current = beacon;
          setAgentEndpoint(beacon);
          sessionRef.current += 1;
          openWebSocket(beacon, sessionRef.current, true);
        } else if (!wsRef.current && !pausedRef.current) {
          openWebSocket(beacon, sessionRef.current, false);
        }
      });

      udp.on('error', (err) => {
        if (!mountedRef.current || udpRef.current !== udp) return;
        setLastError(
          `UDP :${UDP_DISCOVERY_PORT} error: ${err && err.message ? err.message : 'socket error'}`
        );
      });

      udp.bind(UDP_DISCOVERY_PORT, '0.0.0.0', () => {
        if (!mountedRef.current || udpRef.current !== udp) return;
        try {
          udp.setBroadcast(true);
        } catch (_e) {}
        setDiscoveryState('Listening');
      });
    } catch (_err) {
      if (!mountedRef.current) return;
      setDiscoveryState('Direct WS');
    }
  }, [armStaleBeaconWatchdog, hasNativeUdp, openWebSocket]);

  useEffect(() => {
    mountedRef.current = true;
    bindUdpListener();

    return () => {
      mountedRef.current = false;
      clearTimers();
      closeWebSocket(true);
      cleanupBle(true);

      const udp = udpRef.current;
      udpRef.current = null;
      if (udp) {
        try {
          if (typeof udp.removeAllListeners === 'function') {
            udp.removeAllListeners();
          }
        } catch (_e) {}
        try {
          udp.close();
        } catch (_e) {}
      }

      if (bleManagerRef.current && typeof bleManagerRef.current.destroy === 'function') {
        try {
          bleManagerRef.current.destroy();
        } catch (_e) {}
        bleManagerRef.current = null;
      }
    };
  }, [bindUdpListener, cleanupBle, clearTimers, closeWebSocket]);

  const handleManualConnect = () => {
    const cleanHost = normalizeIpv4(manualHost);
    const parsedPort = parseInt(manualPort, 10);
    if (!cleanHost) {
      setLastError('Enter a valid IPv4 address (e.g. 192.168.0.175)');
      return;
    }
    const validPort =
      Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535
        ? parsedPort
        : DEFAULT_WS_PORT;
    const cleanPath = normalizeWsPath(manualPath);

    setPaused(false);
    pausedRef.current = false;
    setLastError('');

    const target = { host: cleanHost, port: validPort, path: cleanPath };
    endpointRef.current = target;
    setAgentEndpoint(target);
    sessionRef.current += 1;
    openWebSocket(target, sessionRef.current, true);
  };

  const handleTogglePause = () => {
    const nextPaused = !paused;
    setPaused(nextPaused);
    pausedRef.current = nextPaused;

    if (nextPaused) {
      closeWebSocket(true);
      setWsState('Idle');
      setStatusMessage('Stream paused by user');
    } else if (endpointRef.current) {
      sessionRef.current += 1;
      openWebSocket(endpointRef.current, sessionRef.current, true);
    } else {
      setStatusMessage('Enter PC IP and tap Connect');
    }
  };

  const handleResetDiscovery = () => {
    setPaused(false);
    pausedRef.current = false;
    endpointRef.current = null;
    setAgentEndpoint(null);
    setLastError('');
    closeWebSocket(true);
    setWsState('Idle');
    setDiscoveryState(hasNativeUdp ? 'Listening' : 'Direct WS');
    setStatusMessage(
      hasNativeUdp
        ? `Listening passively on UDP :${UDP_DISCOVERY_PORT}`
        : 'Connection reset — ready to connect'
    );
    bindUdpListener();
  };

  const isConnected = wsState === 'Connected';
  const isDiscovered = discoveryState === 'Discovered';
  const isWatchPaired =
    bleState === 'Paired' || bleState === 'Pushed' || bleState === 'On Network';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#090d16" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <View style={styles.headerTextCol}>
            <Text style={styles.title}>
              PC Telemetry By David Funso UniAbuja Matric No:24/205EEE/007
            </Text>
            <Text style={styles.subtitle}>
              {hasNativeUdp ? 'UDP Auto-Discovery + Direct WS' : 'Offline Direct WebSocket Client'}
            </Text>
          </View>
          <View style={[styles.badge, isConnected ? styles.badgeConnected : styles.badgePending]}>
            <Text style={styles.badgeText}>{wsState.toUpperCase()}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>Discovery & Link</Text>
            <View style={[styles.miniPill, isDiscovered ? styles.pillOk : styles.pillIdle]}>
              <Text style={styles.miniPillText}>
                {hasNativeUdp ? `UDP :${UDP_DISCOVERY_PORT} · ${discoveryState}` : 'WS :8080'}
              </Text>
            </View>
          </View>

          <Text style={styles.statusText}>{statusMessage}</Text>

          <Text style={styles.metaText}>
            Target Host:{' '}
            {agentEndpoint ? buildWsUrl(agentEndpoint).replace(/^ws:\/\//, '') : 'Not connected'}
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.ipInput]}
              value={manualHost}
              onChangeText={setManualHost}
              placeholder="PC IP (e.g. 192.168.0.175)"
              placeholderTextColor="#64748b"
              keyboardType="numeric"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, styles.portInput]}
              value={manualPort}
              onChangeText={setManualPort}
              placeholder="8080"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
            />
            <Pressable style={styles.connectBtn} onPress={handleManualConnect}>
              <Text style={styles.actionBtnText}>Connect</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            value={manualPath}
            onChangeText={setManualPath}
            placeholder="Optional WS path (e.g. /ws or leave blank)"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {lastError ? <Text style={styles.errorText}>{lastError}</Text> : null}

          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.actionBtn, paused ? styles.btnPrimary : styles.btnSecondary]}
              onPress={handleTogglePause}
            >
              <Text style={styles.actionBtnText}>{paused ? 'Resume Stream' : 'Pause Stream'}</Text>
            </Pressable>
            <Pressable style={styles.btnGhost} onPress={handleResetDiscovery}>
              <Text style={styles.btnGhostText}>Reset</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>ESP32-C3 Watch BLE</Text>
            <View style={[styles.miniPill, isWatchPaired ? styles.pillCharging : styles.pillIdle]}>
              <Text style={styles.miniPillText}>{bleState.toUpperCase()}</Text>
            </View>
          </View>

          <Text style={styles.statusText}>{bleStatusText}</Text>

          <Text style={styles.metaText}>
            Paired Watch:{' '}
            {bleDeviceName
              ? `${bleDeviceName} (${bleDeviceId || 'BLE'})`
              : 'None paired'}
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.ipInput]}
              value={watchWifiSsid}
              onChangeText={setWatchWifiSsid}
              placeholder="Watch Wi-Fi SSID"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, styles.ipInput]}
              value={watchWifiPass}
              onChangeText={setWatchWifiPass}
              placeholder="Wi-Fi Password"
              placeholderTextColor="#64748b"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.actionBtn, styles.btnSecondary]}
              onPress={handleScanAndPairWatch}
              disabled={bleScanning || blePushing}
            >
              <Text style={styles.actionBtnText}>
                {bleScanning ? 'Scanning...' : isWatchPaired ? 'Re-Pair Watch' : 'Scan & Pair'}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.btnPrimary]}
              onPress={handlePushWatchToNetwork}
              disabled={!isWatchPaired || blePushing}
            >
              <Text style={styles.actionBtnText}>
                {blePushing ? 'Pushing...' : 'Push to Network'}
              </Text>
            </Pressable>
            {bleDeviceId ? (
              <Pressable style={styles.btnGhost} onPress={handleDisconnectWatchBle}>
                <Text style={styles.btnGhostText}>Unpair</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.gridRow}>
          <View style={styles.metricCard}>
            <Text style={styles.metricTitle}>CPU LOAD</Text>
            <Text style={styles.metricHero}>{telemetry.cpu}</Text>
            <Text style={styles.metricSub}>Live snapshot</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricTitle}>RAM USAGE</Text>
            <Text style={[styles.metricHero, styles.metricAccent]}>{telemetry.ram}</Text>
            <Text style={styles.metricSub}>{telemetry.memDetail}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>PC Battery</Text>
            <View
              style={[
                styles.miniPill,
                telemetry.isCharging ? styles.pillCharging : styles.pillIdle,
              ]}
            >
              <Text style={styles.miniPillText}>
                {telemetry.isCharging ? 'CHARGING' : 'POWER'}
              </Text>
            </View>
          </View>
          <View style={styles.rowBetween}>
            <Text style={[styles.metricHero, telemetry.isCharging && styles.batteryCharging]}>
              {telemetry.batteryLevel}
            </Text>
            <Text style={styles.metricSub}>{telemetry.batteryDetail}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>PC Storage</Text>
            <Text style={styles.timestampText}>{telemetry.updatedAt}</Text>
          </View>
          <Text style={styles.windowTitle}>{telemetry.storage}</Text>
        </View>

        <View style={styles.gridRow}>
          <View style={styles.netCard}>
            <Text style={styles.metricTitle}>NET DOWN</Text>
            <Text style={styles.netValue}>{telemetry.netDown}</Text>
          </View>
          <View style={styles.netCard}>
            <Text style={styles.metricTitle}>NET UP</Text>
            <Text style={styles.netValue}>{telemetry.netUp}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>Active Window</Text>
            <Text style={styles.timestampText}>{telemetry.updatedAt}</Text>
          </View>
          <Text style={styles.windowTitle}>{telemetry.activeWindow}</Text>
        </View>

        {telemetry.raw ? (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionLabel}>Telemetry JSON</Text>
              <Pressable onPress={() => setShowRawJson((prev) => !prev)}>
                <Text style={styles.toggleLink}>{showRawJson ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
            {showRawJson ? <Text style={styles.codeBlock}>{telemetry.raw}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#090d16',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0,
  },
  container: {
    padding: 16,
    gap: 14,
    paddingBottom: 28,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  subtitle: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    flexShrink: 0,
  },
  badgeConnected: {
    backgroundColor: '#166534',
  },
  badgePending: {
    backgroundColor: '#92400e',
  },
  badgeText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  miniPill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillOk: {
    backgroundColor: '#1e3a8a',
  },
  pillCharging: {
    backgroundColor: '#166534',
  },
  pillIdle: {
    backgroundColor: '#1e293b',
  },
  miniPillText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
  },
  statusText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f1f5f9',
  },
  metaText: {
    fontSize: 12,
    color: '#94a3b8',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  input: {
    backgroundColor: '#090d16',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#f8fafc',
    fontSize: 13,
  },
  ipInput: {
    flex: 2,
  },
  portInput: {
    flex: 0.8,
    textAlign: 'center',
  },
  connectBtn: {
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 12,
    color: '#f87171',
    fontWeight: '500',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#16a34a',
  },
  btnSecondary: {
    backgroundColor: '#2563eb',
  },
  btnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: '#0f172a',
    alignItems: 'center',
  },
  actionBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  btnGhostText: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '600',
  },
  gridRow: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  metricTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    letterSpacing: 0.5,
  },
  metricHero: {
    fontSize: 28,
    fontWeight: '800',
    color: '#38bdf8',
  },
  metricAccent: {
    color: '#34d399',
  },
  batteryCharging: {
    color: '#4ade80',
  },
  metricSub: {
    fontSize: 12,
    color: '#64748b',
  },
  netCard: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    gap: 2,
  },
  netValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  timestampText: {
    fontSize: 12,
    color: '#64748b',
  },
  windowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f8fafc',
    lineHeight: 22,
  },
  toggleLink: {
    fontSize: 12,
    fontWeight: '600',
    color: '#60a5fa',
  },
  codeBlock: {
    fontSize: 12,
    color: '#cbd5e1',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: '#090d16',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
});
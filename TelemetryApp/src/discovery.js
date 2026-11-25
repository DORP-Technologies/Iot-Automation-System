import dgram from 'react-native-udp';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DISCOVERY_PORT = 45678;
const CACHE_KEY = '@telemetry_last_host';

/**
 * Listens for UDP broadcast packets from pc_telemetry_agent.
 * Calls onHostDiscovered({ ip, port }) as soon as a valid beacon arrives.
 * Returns a cleanup function to close the UDP socket.
 */
export function startHostDiscovery(onHostDiscovered, onError) {
  let isClosed = false;
  const socket = dgram.createSocket({ type: 'udp4', reusePort: true });

  socket.on('error', (err) => {
    if (!isClosed && onError) {
      onError(err);
    }
  });

  socket.on('message', async (msg, rinfo) => {
    if (isClosed) return;

    try {
      const raw = msg.toString('utf8');
      const data = JSON.parse(raw);

      if (data && data.service === 'pc_telemetry_agent' && data.port) {
        const hostInfo = {
          ip: rinfo.address, // Automatically captured from sender packet header
          port: Number(data.port),
        };

        // Save to local cache for instant startup on next launch
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(hostInfo));

        // Stop listening once found and notify caller
        cleanup();
        onHostDiscovered(hostInfo);
      }
    } catch (_err) {
      // Ignore non-JSON or unrelated UDP broadcast traffic on the network
    }
  });

  socket.bind(DISCOVERY_PORT, '0.0.0.0', (err) => {
    if (err && onError) {
      onError(err);
    }
  });

  function cleanup() {
    if (!isClosed) {
      isClosed = true;
      try {
        socket.close();
      } catch (_e) {}
    }
  }

  return cleanup;
}

/**
 * Retrieves the last successfully paired host from storage (optional fast path).
 */
export async function getCachedHost() {
  try {
    const saved = await AsyncStorage.getItem(CACHE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (_e) {
    return null;
  }
}

import { useEffect, useState } from 'react';
import { startHostDiscovery, getCachedHost } from '../discovery';

export interface DiscoveredHost {
  ip: string;
  port: number;
}

export type TelemetryPayload = Record<string, unknown>;

export function useTelemetryStream() {
  const [status, setStatus] = useState<string>('Searching for PC telemetry agent...');
  const [host, setHost] = useState<DiscoveredHost | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryPayload | null>(null);

  // Check cached host asynchronously on mount
  useEffect(() => {
    let active = true;

    async function checkCache() {
      try {
        if (typeof getCachedHost === 'function') {
          const cached = await getCachedHost();
          if (active && cached && cached.ip && cached.port) {
            setHost(cached as DiscoveredHost);
            setStatus(`Connected to ${cached.ip}:${cached.port}`);
          }
        }
      } catch {
        // Ignore cache read error and fall back to discovery
      }
    }

    checkCache();
    return () => {
      active = false;
    };
  }, []);

  // Start UDP auto-discovery when no host is currently set
  useEffect(() => {
    if (host) return;

    setStatus('Searching for PC telemetry agent...');
    const stopDiscovery = startHostDiscovery(
      (discoveredHost: DiscoveredHost) => {
        setHost(discoveredHost);
        setStatus(`Connected to ${discoveredHost.ip}:${discoveredHost.port}`);
      },
      (err: { message?: string }) => {
        setStatus(`Discovery error: ${err?.message ?? 'Unknown error'}`);
      }
    );

    return () => {
      if (typeof stopDiscovery === 'function') {
        stopDiscovery();
      }
    };
  }, [host]);

  // Connect WebSocket once host IP and port are discovered
  useEffect(() => {
    if (!host) return;

    const wsUrl = `ws://${host.ip}:${host.port}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus(`Live stream active (${host.ip}:${host.port})`);
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object') {
          setTelemetry(parsed as TelemetryPayload);
        }
      } catch (_e) {}
    };

    ws.onerror = () => {
      setStatus('Connection lost. Re-scanning...');
      setHost(null);
    };

    return () => {
      ws.close();
    };
  }, [host]);

  return { status, host, telemetry };
}

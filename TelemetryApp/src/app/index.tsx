import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useTelemetryStream } from '../hooks/useTelemetryStream';

export default function IndexScreen() {
  const { status, host, telemetry } = useTelemetryStream();

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
      {!host && <ActivityIndicator size="large" />}
      <Text style={{ marginTop: 12, fontSize: 16 }}>{status}</Text>
      {telemetry !== null && (
        <Text style={{ marginTop: 20 }}>
          {JSON.stringify(telemetry, null, 2)}
        </Text>
      )}
    </View>
  );
}

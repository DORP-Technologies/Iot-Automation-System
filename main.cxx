#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <Preferences.h>
#include <NimBLEDevice.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

// ---------------- BLE Provisioning UUIDs ----------------
#define BLE_DEVICE_NAME       "ESP32C3-Watch"
#define SERVICE_UUID          "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define PROVISION_CHAR_UUID   "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define STATUS_CHAR_UUID      "1c95d5e3-d8db-4373-b650-cfdc93e0e345"

static const uint16_t UDP_DISCOVERY_PORT = 45678;
static const uint16_t DEFAULT_WS_PORT    = 8080;

Preferences prefs;
WebSocketsClient wsClient;
WiFiUDP udp;
NimBLECharacteristic* statusChar = nullptr;

String wifiSsid = "";
String wifiPass = "";
String wsHost   = "";
uint16_t wsPort = DEFAULT_WS_PORT;

volatile bool pendingProvision = false;
String pendingJson = "";
bool wsConnected = false;

// Latest telemetry state for watch UI
float cpuPct = 0.0f;
float ramPct = 0.0f;
float batPct = -1.0f;
bool isCharging = false;
String batState = "--";
String activeWin = "Waiting...";

void notifyStatus(const String& msg) {
  Serial.println("[BLE/SYS] " + msg);
  if (statusChar != nullptr) {
    statusChar->setValue(msg.c_str());
    statusChar->notify();
  }
}

// Hook your display library (ST7789 / ST7735 / SSD1306 / U8g2) here
void drawWatchTelemetry() {
  Serial.printf(
    "[WATCH UI] WiFi:%s | WS:%s | CPU:%.1f%% | RAM:%.1f%% | BAT:%.1f%% (%s) | Win:%s\n",
    WiFi.status() == WL_CONNECTED ? "OK" : "NO",
    wsConnected ? "LIVE" : "OFF",
    cpuPct,
    ramPct,
    batPct,
    isCharging ? "CHG" : batState.c_str(),
    activeWin.c_str()
  );
}

void saveConfig() {
  prefs.begin("telemetry_cfg", false);
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPass);
  prefs.putString("wshost", wsHost);
  prefs.putUInt("wsport", wsPort);
  prefs.end();
}

void loadConfig() {
  prefs.begin("telemetry_cfg", true);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  wsHost   = prefs.getString("wshost", "");
  wsPort   = (uint16_t)prefs.getUInt("wsport", DEFAULT_WS_PORT);
  prefs.end();
}

void startWebSocket() {
  if (wsHost.length() == 0) {
    notifyStatus("WAITING_FOR_HOST");
    return;
  }
  wsClient.disconnect();
  wsClient.begin(wsHost.c_str(), wsPort, "/");
  wsClient.setReconnectInterval(2500);
  notifyStatus("WS_CONNECTING:" + wsHost + ":" + String(wsPort));
}

bool connectWiFi(uint32_t timeoutMs = 15000) {
  if (wifiSsid.length() == 0) {
    notifyStatus("NO_WIFI_CREDS");
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Important for low-latency Wi-Fi + BLE coexistence
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  notifyStatus("WIFI_CONNECTING:" + wifiSsid);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    udp.begin(UDP_DISCOVERY_PORT);
    notifyStatus("WIFI_CONNECTED:" + WiFi.localIP().toString());
    drawWatchTelemetry();
    startWebSocket();
    return true;
  }

  notifyStatus("WIFI_FAILED");
  drawWatchTelemetry();
  return false;
}

void pollUdpBeacon() {
  if (WiFi.status() != WL_CONNECTED || wsHost.length() > 0) return;

  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    char buf[256];
    int len = udp.read(buf, sizeof(buf) - 1);
    if (len > 0) {
      buf[len] = '\0';
      JsonDocument doc;
      if (deserializeJson(doc, buf) == DeserializationError::Ok) {
        const char* svc = doc["service"] | "";
        if (String(svc) == "pc_telemetry_agent") {
          wsHost = udp.remoteIP().toString();
          wsPort = doc["port"] | DEFAULT_WS_PORT;
          saveConfig();
          startWebSocket();
        }
      }
    }
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      wsConnected = false;
      drawWatchTelemetry();
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      notifyStatus("WS_CONNECTED");
      drawWatchTelemetry();
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (!err) {
        cpuPct     = doc["cpu_usage_percent"] | 0.0f;
        ramPct     = doc["ram_usage_percent"] | 0.0f;
        batPct     = doc["battery_percent"].isNull() ? -1.0f : (doc["battery_percent"] | -1.0f);
        isCharging = doc["is_charging"] | false;
        batState   = String(doc["battery_state"] | "--");
        activeWin  = String(doc["active_window"] | "Unknown");
        drawWatchTelemetry();
      }
      break;
    }

    default:
      break;
  }
}

class ProvisionCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) override {
    std::string rx = pCharacteristic->getValue();
    if (!rx.empty()) {
      pendingJson = String(rx.c_str());
      pendingProvision = true;
    }
  }
};

void initBle() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer* pServer = NimBLEDevice::createServer();
  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  NimBLECharacteristic* provChar = pService->createCharacteristic(
    PROVISION_CHAR_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  provChar->setCallbacks(new ProvisionCallbacks());

  statusChar = pService->createCharacteristic(
    STATUS_CHAR_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );
  statusChar->setValue("IDLE");

  pService->start();

  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();
  Serial.println("[BLE] Advertising ready for Android pairing.");
}

void applyProvisioningPayload() {
  pendingProvision = false;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, pendingJson);
  if (err) {
    notifyStatus("INVALID_JSON");
    return;
  }

  String newSsid = String(doc["ssid"] | "");
  String newPass = String(doc["pass"] | "");
  String newHost = String(doc["ws_host"] | "");
  uint16_t newPort = (uint16_t)(doc["ws_port"] | DEFAULT_WS_PORT);

  if (newSsid.length() == 0) {
    notifyStatus("MISSING_SSID");
    return;
  }

  wifiSsid = newSsid;
  wifiPass = newPass;
  if (newHost.length() > 0) {
    wsHost = newHost;
  }
  wsPort = newPort;
  saveConfig();

  if (connectWiFi()) {
    startWebSocket();
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  loadConfig();
  initBle();
  wsClient.onEvent(onWsEvent);

  if (wifiSsid.length() > 0) {
    connectWiFi();
  } else {
    drawWatchTelemetry();
  }
}

void loop() {
  if (pendingProvision) {
    applyProvisioningPayload();
  }

  if (WiFi.status() == WL_CONNECTED) {
    pollUdpBeacon();
    wsClient.loop();
  }

  delay(10);
}



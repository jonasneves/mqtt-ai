/**
 * ESP32-CAM-MB — Motor control via MQTT, with OTA updates
 *
 * Topics (MAC-based):
 *   devices/<mac>/motors/command   ← {"left": 0.5, "right": -0.5}
 *
 * Payload values are floats in [-1.0, 1.0]:
 *   positive = forward, negative = backward, 0 = stop
 *
 * Motors auto-stop if no command is received within COMMAND_TIMEOUT_MS
 * (safety: browser tab closed, WiFi drop, etc.)
 *
 * GPIO wiring (L298N → ESP32-CAM-MB):
 *   ENA → GPIO 14    ENB → GPIO 4
 *   IN1 → GPIO 12    IN3 → GPIO 15
 *   IN2 → GPIO 13    IN4 → GPIO 16
 *
 * Required libraries (Tools → Manage Libraries):
 *   - PubSubClient by Nick O'Leary
 *
 * Board: AI Thinker ESP32-CAM
 * Port:  /dev/cu.usbserial-* (USB)
 */

#include <WiFi.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

#ifndef WIFI_SSID
#define WIFI_SSID "your_wifi_ssid"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "your_wifi_password"
#endif
#ifndef MQTT_IP
#define MQTT_IP "broker.hivemq.com"
#endif

const int          MQTT_PORT          = 1883;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
const unsigned long COMMAND_TIMEOUT_MS    = 500;  // stop motors if silent

// L298N wiring — adjust pins to match your build
const int ENA = 14;  const int IN1 = 12;  const int IN2 = 13;  // left motor
const int ENB =  4;  const int IN3 = 15;  const int IN4 = 16;  // right motor

// LEDC (PWM)
const int PWM_FREQ = 1000;  // Hz
const int PWM_RES  = 8;     // bits (0–255)
const int PWM_CH_L = 0;
const int PWM_CH_R = 1;

const char* TOPIC_PREFIX = "devices/";

String motorsTopic;    // devices/<mac>/motors/command
String announceTopic;  // devices/<mac>
String clientId;
String announcement;

unsigned long lastCommandMs = 0;

WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ── Topics ──────────────────────────────────────────────────────────────────

void buildTopicsFromMAC() {
  String mac = WiFi.macAddress();
  mac.toLowerCase();
  mac.replace(":", "");

  announceTopic = String(TOPIC_PREFIX) + mac;
  motorsTopic   = announceTopic + "/motors/command";
  clientId      = "esp32-car-" + mac;
  announcement  = "{\"topics\":[\"" + motorsTopic + "\"]}";

  Serial.println("Topic: " + motorsTopic);
}

// ── Motors ──────────────────────────────────────────────────────────────────

void setMotor(int ch, int pinA, int pinB, float speed) {
  speed = constrain(speed, -1.0f, 1.0f);
  int duty = (int)(fabsf(speed) * 255);

  if (speed > 0)       { digitalWrite(pinA, HIGH); digitalWrite(pinB, LOW);  }
  else if (speed < 0)  { digitalWrite(pinA, LOW);  digitalWrite(pinB, HIGH); }
  else                 { digitalWrite(pinA, LOW);  digitalWrite(pinB, LOW);  }

  ledcWrite(ch, duty);
}

void stopMotors() {
  setMotor(PWM_CH_L, IN1, IN2, 0);
  setMotor(PWM_CH_R, IN3, IN4, 0);
}

void setupMotors() {
  ledcSetup(PWM_CH_L, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENA, PWM_CH_L);
  ledcSetup(PWM_CH_R, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENB, PWM_CH_R);

  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);

  stopMotors();
}

// ── MQTT message handler ─────────────────────────────────────────────────────

void onMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, motorsTopic.c_str()) != 0) return;

  char buf[length + 1];
  memcpy(buf, payload, length);
  buf[length] = '\0';

  // Parse {"left": <float>, "right": <float>} without a JSON library.
  // strstr finds the key, then sscanf skips the colon and parses the value.
  float left = 0, right = 0;
  const char* lp = strstr(buf, "\"left\"");
  const char* rp = strstr(buf, "\"right\"");
  if (lp) sscanf(lp + 6, " :%f", &left);   // +6 skips past "left"
  if (rp) sscanf(rp + 7, " :%f", &right);  // +7 skips past "right"

  setMotor(PWM_CH_L, IN1, IN2, left);
  setMotor(PWM_CH_R, IN3, IN4, right);
  lastCommandMs = millis();
}

// ── OTA ──────────────────────────────────────────────────────────────────────

void setupOTA() {
  ArduinoOTA.setHostname("esp32-car");
  ArduinoOTA.onStart([]() {
    stopMotors();
    mqttClient.disconnect();
    Serial.println("OTA start");
  });
  ArduinoOTA.onEnd([]()   { Serial.println("OTA done"); });
  ArduinoOTA.onError([](ota_error_t e) { Serial.printf("OTA error [%u]\n", e); });
  ArduinoOTA.begin();
  Serial.println("OTA ready — `make ota ESP32_IP=" + WiFi.localIP().toString() + "`");
}

// ── MQTT reconnect ───────────────────────────────────────────────────────────

void mqttReconnect() {
  static unsigned long lastAttemptMs = 0;
  unsigned long now = millis();
  if (now - lastAttemptMs < RECONNECT_INTERVAL_MS) return;
  lastAttemptMs = now;

  Serial.print("Connecting to MQTT...");
  if (!mqttClient.connect(clientId.c_str())) {
    Serial.print(" failed, rc=");
    Serial.println(mqttClient.state());
    return;
  }

  Serial.println(" connected (" + String(MQTT_IP) + ")");
  mqttClient.publish(announceTopic.c_str(), announcement.c_str(), true);
  mqttClient.subscribe(motorsTopic.c_str());
}

// ── Setup / loop ─────────────────────────────────────────────────────────────

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);  // disable brownout detector
  Serial.begin(115200);
  delay(2000);

  setupMotors();

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  buildTopicsFromMAC();
  setupOTA();

  mqttClient.setServer(MQTT_IP, MQTT_PORT);
  mqttClient.setCallback(onMessage);
}

void loop() {
  ArduinoOTA.handle();

  if (mqttClient.connected()) {
    mqttClient.loop();
    // Auto-stop if no command received recently
    if (lastCommandMs > 0 && millis() - lastCommandMs > COMMAND_TIMEOUT_MS) {
      stopMotors();
      lastCommandMs = 0;
    }
  } else {
    stopMotors();
    mqttReconnect();
  }
}

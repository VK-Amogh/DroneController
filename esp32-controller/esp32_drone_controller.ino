/*
 ==============================================================================
  ESP32 FPV Drone Motion Controller  —  v3.0  (WiFi WebSocket + USB Serial)
 ==============================================================================
  TWO TRANSPORT MODES (select below):
    1. WiFi AP Mode   — ESP32 creates its own WiFi hotspot.
                        Simulator laptop joins that hotspot.
                        WebSocket URL: ws://192.168.4.1:81
                        ✅ Works without a router. Easiest setup.

    2. WiFi STA Mode  — ESP32 joins your existing WiFi router.
                        Simulator laptop must be on the SAME network.
                        WebSocket URL: ws://<ESP32-IP>:81  (printed on Serial)
                        ✅ Best if you want both laptops on the internet too.

  USB Serial still works simultaneously at 115200 baud for debugging
  and as a fallback transport (same JSON packets).

  Required Library (install once in Arduino IDE):
    ➜ Sketch → Include Library → Manage Libraries
    ➜ Search: "WebSockets"  by  Markus Sattler  (arduinoWebSockets)
    ➜ Click Install  (latest version, e.g. 2.4.x)

  Hardware:
    MPU6050 SDA  → GPIO 21
    MPU6050 SCL  → GPIO 22
    MPU6050 AD0  → GND         (I2C address 0x68)
    MPU6050 VCC  → 3V3
    MPU6050 GND  → GND
    Button  UP   → GPIO 18  (other leg to GND)
    Button  DOWN → GPIO 19  (other leg to GND)
    LED          → GPIO 2   (onboard blue LED)

  Packet format  (sent at 50 Hz over both WiFi and Serial):
    {"p":0.25,"r":-0.10,"y":0.00,"u":1,"d":0}
    p=pitch  r=roll  y=yaw   u=up-btn  d=down-btn   rst=1 on reset
 ==============================================================================
*/

// ─────────────────────────────────────────────────────────────────────────────
//  ❶  USER CONFIG  — edit this section before flashing
// ─────────────────────────────────────────────────────────────────────────────

// WiFi mode: 1 = Access Point (AP), 2 = Station (join existing router)
#define WIFI_MODE        1

// --- AP Mode credentials (what the simulator laptop connects to) ---
#define AP_SSID          "FPV-Drone-Ctrl"
#define AP_PASSWORD      "fly12345"        // min 8 chars; leave "" for open network

// --- STA Mode credentials (your home / office router) ---
#define STA_SSID         "YourRouterSSID"
#define STA_PASSWORD     "YourRouterPassword"
#define STA_TIMEOUT_MS   15000             // 15 s max wait for connection

// WebSocket server port
#define WS_PORT          81

// Set to 1 to include gyro yaw-rate in the packet; 0 = always y:0.00
#define YAW_ENABLED      0

// ─────────────────────────────────────────────────────────────────────────────
//  ❷  HARDWARE PINS
// ─────────────────────────────────────────────────────────────────────────────
#define PIN_SDA          21
#define PIN_SCL          22
#define PIN_BTN_UP       18
#define PIN_BTN_DOWN     19
#define PIN_STATUS_LED   2

// ─────────────────────────────────────────────────────────────────────────────
//  ❸  SENSOR / CONTROL TUNING
// ─────────────────────────────────────────────────────────────────────────────
#define SAMPLE_HZ        50
#define SAMPLE_MS        (1000 / SAMPLE_HZ)   // 20 ms
#define CAL_SAMPLES      200
#define DEADZONE_DEG     3.5f
#define MAX_TILT_DEG     35.0f
#define MAX_YAW_DEG_S    90.0f
#define COMP_ALPHA       0.96f
#define RESET_HOLD_MS    3000UL

// MPU6050 registers
#define MPU_ADDR         0x68
#define REG_CONFIG       0x1A
#define REG_GYRO_CFG     0x1B
#define REG_ACCEL_CFG    0x1C
#define REG_SMPLRT_DIV   0x19
#define REG_PWR_MGMT_1   0x6B
#define REG_WHO_AM_I     0x75
#define REG_ACCEL_XOUT   0x3B

// ─────────────────────────────────────────────────────────────────────────────
//  ❹  INCLUDES
// ─────────────────────────────────────────────────────────────────────────────
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsServer.h>   // ← arduinoWebSockets library by Markus Sattler

// ─────────────────────────────────────────────────────────────────────────────
//  ❺  GLOBALS
// ─────────────────────────────────────────────────────────────────────────────

WebSocketsServer wsServer(WS_PORT);

// Active WebSocket client number (-1 = none connected)
int8_t  wsClientNum = -1;

// Sensor calibration offsets
float ax_off = 0, ay_off = 0;
float gx_off = 0, gy_off = 0, gz_off = 0;

// Filtered angles
float pitch    = 0.0f;
float roll     = 0.0f;
float yaw_rate = 0.0f;

// Button state (debounced)
bool btnUpNow   = false;
bool btnDownNow = false;

// Dual-button reset
unsigned long dualHeldStart = 0;
bool          resetFired    = false;

// Timing
unsigned long lastTxMs   = 0;
unsigned long lastLoopUs = 0;
bool          mpuOK      = false;

// ─────────────────────────────────────────────────────────────────────────────
//  ❻  I2C HELPERS
// ─────────────────────────────────────────────────────────────────────────────
static bool i2cWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return (Wire.endTransmission(true) == 0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❼  MPU6050 INIT
// ─────────────────────────────────────────────────────────────────────────────
bool initMPU6050() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  delay(50);

  // WHO_AM_I sanity check
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_WHO_AM_I);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)1, (uint8_t)true);
  if (!Wire.available()) return false;
  uint8_t id = Wire.read();
  if (id != 0x68 && id != 0x72) return false;

  i2cWrite(REG_PWR_MGMT_1, 0x01);   // Wake + use PLL with X gyro clock
  delay(10);
  i2cWrite(REG_GYRO_CFG,   0x00);   // ±250 °/s
  i2cWrite(REG_ACCEL_CFG,  0x00);   // ±2 g
  i2cWrite(REG_CONFIG,     0x04);   // DLPF ~21 Hz
  i2cWrite(REG_SMPLRT_DIV, 0x00);   // 1 kHz internal rate
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❽  RAW READ
// ─────────────────────────────────────────────────────────────────────────────
bool readRaw(int16_t &ax, int16_t &ay, int16_t &az,
             int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACCEL_XOUT);
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14, (uint8_t)true);
  if (Wire.available() < 14) return false;

  ax = (int16_t)((Wire.read() << 8) | Wire.read());
  ay = (int16_t)((Wire.read() << 8) | Wire.read());
  az = (int16_t)((Wire.read() << 8) | Wire.read());
  Wire.read(); Wire.read();          // skip temp
  gx = (int16_t)((Wire.read() << 8) | Wire.read());
  gy = (int16_t)((Wire.read() << 8) | Wire.read());
  gz = (int16_t)((Wire.read() << 8) | Wire.read());
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❾  AUTO-CALIBRATION  (hold flat & still during the LED blink phase)
// ─────────────────────────────────────────────────────────────────────────────
void calibrateMPU() {
  double axS = 0, ayS = 0, gxS = 0, gyS = 0, gzS = 0;
  int    n   = 0;

  for (int i = 0; i < CAL_SAMPLES; i++) {
    if (i % 20 == 0) digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    int16_t ax, ay, az, gx, gy, gz;
    if (readRaw(ax, ay, az, gx, gy, gz)) {
      axS += ax / 16384.0; ayS += ay / 16384.0;
      gxS += gx / 131.0;  gyS += gy / 131.0; gzS += gz / 131.0;
      n++;
    }
    delay(5);
  }

  if (n > 10) {
    ax_off = (float)(axS / n); ay_off = (float)(ayS / n);
    gx_off = (float)(gxS / n); gy_off = (float)(gyS / n); gz_off = (float)(gzS / n);
  }
  digitalWrite(PIN_STATUS_LED, HIGH);  // solid = ready
}

// ─────────────────────────────────────────────────────────────────────────────
//  ❿  COMPLEMENTARY FILTER UPDATE
// ─────────────────────────────────────────────────────────────────────────────
void updateSensor(float dt) {
  int16_t ax, ay, az, gx, gy, gz;
  if (!readRaw(ax, ay, az, gx, gy, gz)) { mpuOK = false; return; }

  float Ax = ax / 16384.0f - ax_off;
  float Ay = ay / 16384.0f - ay_off;
  float Az = az / 16384.0f;
  float Gx = gx / 131.0f  - gx_off;
  float Gy = gy / 131.0f  - gy_off;
  float Gz = gz / 131.0f  - gz_off;

  yaw_rate = Gz;

  float accelPitch = atan2f(-Ax, sqrtf(Ay*Ay + Az*Az)) * (180.0f / PI);
  float accelRoll  = atan2f( Ay, Az)                   * (180.0f / PI);

  pitch = COMP_ALPHA * (pitch + Gy * dt) + (1.0f - COMP_ALPHA) * accelPitch;
  roll  = COMP_ALPHA * (roll  + Gx * dt) + (1.0f - COMP_ALPHA) * accelRoll;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⓫  DEADZONE + EXPO NORMALIZER
// ─────────────────────────────────────────────────────────────────────────────
float normalizeAxis(float v, float maxV, float dz) {
  float a = fabsf(v);
  if (a <= dz) return 0.0f;
  float n = constrain((a - dz) / (maxV - dz), 0.0f, 1.0f);
  float e = 0.55f * n + 0.45f * n * n;   // gentle expo
  return (v < 0) ? -e : e;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⓬  WEBSOCKET EVENT HANDLER
// ─────────────────────────────────────────────────────────────────────────────
void onWebSocketEvent(uint8_t clientNum, WStype_t type,
                      uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsClientNum = clientNum;
      digitalWrite(PIN_STATUS_LED, HIGH);
      Serial.printf("[WS] Client #%u connected from %s\n",
                    clientNum,
                    wsServer.remoteIP(clientNum).toString().c_str());
      wsServer.sendTXT(clientNum, "{\"hello\":\"FPV-Drone-Ctrl\",\"ver\":3}");
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client #%u disconnected\n", clientNum);
      if (wsClientNum == clientNum) wsClientNum = -1;
      break;

    case WStype_TEXT:
      // Accept optional commands from browser (e.g. ping or recal request)
      if (length >= 3 && strncmp((char*)payload, "CAL", 3) == 0) {
        Serial.println("[WS] Recalibration requested by browser");
        calibrateMPU();
        wsServer.sendTXT(clientNum, "{\"cal\":1}");
      }
      break;

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⓭  WIFI SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setupWiFi() {
  Serial.println("[WiFi] Starting...");

#if WIFI_MODE == 1
  // ── Access Point Mode ──────────────────────────────────────────────────────
  WiFi.mode(WIFI_AP);
  const char* apPass = strlen(AP_PASSWORD) >= 8 ? AP_PASSWORD : nullptr;
  WiFi.softAP(AP_SSID, apPass);
  delay(100);   // AP interface needs a moment to come up

  IPAddress apIP = WiFi.softAPIP();
  Serial.printf("[WiFi] AP ready  SSID: %s  IP: %s\n", AP_SSID, apIP.toString().c_str());
  Serial.printf("[WiFi] Browser WebSocket URL: ws://%s:%d\n", apIP.toString().c_str(), WS_PORT);

#else
  // ── Station Mode (join existing router) ───────────────────────────────────
  WiFi.mode(WIFI_STA);
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.printf("[WiFi] Connecting to '%s' ", STA_SSID);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > STA_TIMEOUT_MS) {
      Serial.println("\n[WiFi] TIMEOUT — falling back to AP mode");
      WiFi.mode(WIFI_AP);
      WiFi.softAP(AP_SSID, strlen(AP_PASSWORD) >= 8 ? AP_PASSWORD : nullptr);
      delay(100);
      IPAddress apIP = WiFi.softAPIP();
      Serial.printf("[WiFi] AP fallback  SSID: %s  IP: %s\n", AP_SSID, apIP.toString().c_str());
      Serial.printf("[WiFi] ws://%s:%d\n", apIP.toString().c_str(), WS_PORT);
      return;
    }
    delay(300);
    Serial.print('.');
    // Blink LED during connection attempt
    digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
  }

  IPAddress ip = WiFi.localIP();
  Serial.printf("\n[WiFi] Connected!  IP: %s\n", ip.toString().c_str());
  Serial.printf("[WiFi] Browser WebSocket URL: ws://%s:%d\n", ip.toString().c_str(), WS_PORT);
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⓮  SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 1500) {}

  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);
  pinMode(PIN_BTN_UP,   INPUT_PULLUP);
  pinMode(PIN_BTN_DOWN, INPUT_PULLUP);

  Serial.println("\n========== FPV Drone Controller v3.0 ==========");

  // ── MPU6050 ──────────────────────────────────────────────────────────────
  mpuOK = initMPU6050();
  if (mpuOK) {
    Serial.println("[MPU] Found MPU6050 — calibrating (hold flat & still)...");
    calibrateMPU();
    Serial.println("[MPU] Calibration done.");
  } else {
    Serial.println("[MPU] ERROR: MPU6050 not detected! Check wiring.");
  }

  // ── WiFi + WebSocket ──────────────────────────────────────────────────────
  setupWiFi();
  wsServer.begin();
  wsServer.onEvent(onWebSocketEvent);
  Serial.printf("[WS] WebSocket server started on port %d\n", WS_PORT);

  // Boot message over Serial (USB debugging / fallback transport)
  Serial.println("{\"boot\":1}");

  lastTxMs   = millis();
  lastLoopUs = micros();
  Serial.println("================================================\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⓯  MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  // Must call this every iteration — handles WebSocket keepalive & framing
  wsServer.loop();

  unsigned long nowMs = millis();
  unsigned long nowUs = micros();
  float dt = (float)(nowUs - lastLoopUs) / 1000000.0f;
  if (dt <= 0.0f || dt > 0.2f) dt = 0.02f;
  lastLoopUs = nowUs;

  // ── MPU reconnect if wiring was bad at boot ─────────────────────────────
  if (!mpuOK) {
    if ((nowMs / 150) % 2 == 0) digitalWrite(PIN_STATUS_LED, HIGH);
    else                        digitalWrite(PIN_STATUS_LED, LOW);

    static unsigned long lastRetry = 0;
    if (nowMs - lastRetry > 2000) {
      lastRetry = nowMs;
      mpuOK = initMPU6050();
      if (mpuOK) {
        calibrateMPU();
        Serial.println("{\"cal\":1}");
      }
    }
  } else {
    updateSensor(dt);
  }

  // ── Buttons (20 ms debounce) ────────────────────────────────────────────
  {
    static bool lastUp = false, lastDown = false;
    static unsigned long tUp = 0, tDown = 0;
    bool rawUp   = (digitalRead(PIN_BTN_UP)   == LOW);
    bool rawDown = (digitalRead(PIN_BTN_DOWN) == LOW);
    if (rawUp   != lastUp   && nowMs - tUp   > 20) { btnUpNow   = rawUp;   lastUp   = rawUp;   tUp   = nowMs; }
    if (rawDown != lastDown && nowMs - tDown > 20) { btnDownNow = rawDown; lastDown = rawDown; tDown = nowMs; }
  }

  // ── Dual-button 3 s reset ───────────────────────────────────────────────
  int sendReset = 0;
  if (btnUpNow && btnDownNow) {
    if (!dualHeldStart) dualHeldStart = nowMs;
    if (!resetFired && (nowMs - dualHeldStart >= RESET_HOLD_MS)) {
      sendReset = 1;
      resetFired = true;
      for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_STATUS_LED, LOW);  delay(60);
        digitalWrite(PIN_STATUS_LED, HIGH); delay(60);
      }
    }
  } else {
    dualHeldStart = 0;
    resetFired    = false;
  }

  // ── Transmit at 50 Hz ───────────────────────────────────────────────────
  if (nowMs - lastTxMs >= SAMPLE_MS) {
    lastTxMs = nowMs;

    float outP = 0, outR = 0, outY = 0;
    if (mpuOK) {
      outP = -normalizeAxis(pitch,    MAX_TILT_DEG,  DEADZONE_DEG);
      outR =  normalizeAxis(roll,     MAX_TILT_DEG,  DEADZONE_DEG);
#if YAW_ENABLED
      outY = -normalizeAxis(yaw_rate, MAX_YAW_DEG_S, 5.0f);
#endif
    }

    // Build JSON string
    char buf[96];
    int len = snprintf(buf, sizeof(buf),
      "{\"p\":%.2f,\"r\":%.2f,\"y\":%.2f,\"u\":%d,\"d\":%d%s}",
      outP, outR, outY,
      btnUpNow ? 1 : 0,
      btnDownNow ? 1 : 0,
      sendReset ? ",\"rst\":1" : ""
    );

    // Send over WebSocket (WiFi) to connected browser
    if (wsClientNum >= 0) {
      wsServer.sendTXT(wsClientNum, buf, len);
    }

    // Always send over Serial too (USB fallback / debugging)
    Serial.println(buf);
  }
}

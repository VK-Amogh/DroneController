# 🎮 ESP32 FPV Drone Motion Controller  v3.0

An authentic physical motion controller for the **FPV Drone Simulator** using an **ESP32** and an **MPU6050** 6-axis gyroscope/accelerometer, with two push buttons for altitude control.

Supports **two connection modes**:
| Mode | How | Best For |
|:---|:---|:---|
| 📶 **WiFi WebSocket** | ESP32 hotspot → browser WebSocket | Cross-laptop wireless use |
| 🔌 **USB Serial** | USB cable → Web Serial API | Single laptop, easiest setup |

Both modes use the same JSON telemetry packet format and can be switched at any time without reflashing.

---

## 🔌 Hardware Wiring

```
 ┌────────────────────────────────────────────────────────┐
 │                    ESP32 Dev Board                     │
 │                                                        │
 │  [3V3] ────────────────────────► MPU6050 VCC          │
 │  [GND] ────────────────────────► MPU6050 GND          │
 │  [GPIO 21 / SDA] ──────────────► MPU6050 SDA          │
 │  [GPIO 22 / SCL] ──────────────► MPU6050 SCL          │
 │                                   MPU6050 AD0 → GND   │
 │                                   MPU6050 INT → (NC)  │
 │                                                        │
 │  [GPIO 18] ──[ Button UP   ]──► GND (PULLUP)         │
 │  [GPIO 19] ──[ Button DOWN ]──► GND (PULLUP)         │
 │  [GPIO 2 ] ──► Onboard LED (Status)                  │
 └────────────────────────────────────────────────────────┘
```

| Component | Pin | ESP32 GPIO | Notes |
|:---|:---|:---|:---|
| MPU6050 | VCC | **3V3** | GY-521 modules also accept 5V (have onboard LDO) |
| MPU6050 | GND | **GND** | |
| MPU6050 | SDA | **GPIO 21** | I2C Data |
| MPU6050 | SCL | **GPIO 22** | I2C Clock |
| MPU6050 | AD0 | **GND** | ⚠️ Must be GND — sets address to 0x68 |
| MPU6050 | INT | *(NC)* | Leave unconnected |
| Button UP | Pin 1 | **GPIO 18** | Active LOW + PULLUP |
| Button UP | Pin 2 | **GND** | |
| Button DOWN | Pin 1 | **GPIO 19** | Active LOW + PULLUP |
| Button DOWN | Pin 2 | **GND** | |

---

## 🚀 Flashing Firmware (on Laptop B — dev machine)

### Step 1 — Install Dependencies

1. Install [Arduino IDE](https://www.arduino.cc/en/software)
2. Add ESP32 board support:
   - **File → Preferences → Additional Board Manager URLs**:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - **Tools → Board → Boards Manager** → search `esp32` (by Espressif) → **Install**
3. Install the WebSocket library (required for WiFi mode):
   - **Sketch → Include Library → Manage Libraries**
   - Search: **`WebSockets`** by **Markus Sattler**
   - Click **Install**

### Step 2 — Configure the Sketch

Open `esp32_drone_controller.ino` and edit the config section at the top:

```cpp
// WiFi mode: 1 = Access Point (create hotspot), 2 = Station (join your router)
#define WIFI_MODE        1

// AP hotspot name & password (Laptop A connects to this)
#define AP_SSID          "FPV-Drone-Ctrl"
#define AP_PASSWORD      "fly12345"        // min 8 chars

// Station mode (if WIFI_MODE = 2): your router credentials
#define STA_SSID         "YourRouterSSID"
#define STA_PASSWORD     "YourRouterPassword"
```

### Step 3 — Flash

- **Tools → Board → ESP32 Dev Module**
- **Tools → Port →** select your ESP32 COM port
- Click **Upload** → hold **BOOT** button until flashing starts
- LED blinks during calibration (~1 sec), then **solid ON** = ready

### Step 4 — Check Serial Monitor (optional)

Open **Tools → Serial Monitor** at `115200` baud. You'll see:
```
========== FPV Drone Controller v3.0 ==========
[MPU] Found MPU6050 — calibrating...
[MPU] Calibration done.
[WiFi] AP ready  SSID: FPV-Drone-Ctrl  IP: 192.168.4.1
[WS] WebSocket server started on port 81
```

Copy the WebSocket URL shown — you'll need it on Laptop A.

---

## 🌐 Connecting Over WiFi (cross-laptop — Laptop A)

> **Laptop B** flashes the ESP32 and stays on your home network.  
> **Laptop A** runs the simulator and connects wirelessly to the ESP32.

1. Power on the ESP32 (USB power bank, charger, or Laptop B).
2. On **Laptop A**, connect to the WiFi hotspot:
   - **Network name**: `FPV-Drone-Ctrl`
   - **Password**: `fly12345`
3. Open the simulator in Chrome/Edge/Brave: `http://localhost:5173/` (or wherever it's served)
4. Click the **`🎮 CONNECT ESP32`** button in the top-right of the simulator.
5. The connection dialog appears — stay on the **📶 WiFi** tab.
6. The URL should already be `ws://192.168.4.1:81` — click **Connect via WiFi**.
7. The button turns green: **`🎮 ESP32 📶 WiFi`** — you're flying!

> **💡 STA Mode tip**: If using WIFI_MODE=2 (join router), both laptops must be on the same router network. Enter `ws://<IP-shown-in-serial>:81` in the URL field.

---

## 🔌 Connecting Over USB (single laptop)

1. Plug ESP32 into the **simulator laptop** via USB.
2. Click **`🎮 CONNECT ESP32`** → switch to **🔌 USB Cable** tab.
3. Click **Connect via USB** → select your ESP32 COM port.
4. ⚠️ **Requires Chrome, Edge, or Brave** (Firefox / Safari not supported).

---

## 🕹️ Controls

| Motion / Button | Simulator Action |
|:---|:---|
| Tilt forward (nose down) | Fly forward (`W`) |
| Tilt backward (nose up) | Fly backward (`S`) |
| Tilt left | Strafe left (`A`) |
| Tilt right | Strafe right (`D`) |
| Press Button UP | Climb (`↑`) |
| Press Button DOWN | Descend (`↓`) |
| Release buttons | Auto-hover |
| Hold BOTH buttons 3 s | Reset drone to pad (`R`) |

> Keyboard, touchpad, and ESP32 all work **simultaneously**. Each axis gives priority to whichever is actively used — they don't conflict.

---

## 📡 Telemetry Packet Format

Both WiFi and USB send the same JSON at 50 Hz:
```json
{"p":-0.42,"r":0.15,"y":0.00,"u":0,"d":1}
```
| Key | Meaning | Range |
|:---|:---|:---|
| `p` | Pitch (forward/back tilt) | -1.0 … +1.0 |
| `r` | Roll (left/right tilt) | -1.0 … +1.0 |
| `y` | Yaw rate (twist) | -1.0 … +1.0 |
| `u` | UP button | 0 or 1 |
| `d` | DOWN button | 0 or 1 |
| `rst` | Reset trigger | 1 (once on 3 s hold) |

---

## 🛠️ Troubleshooting

| Symptom | Cause | Fix |
|:---|:---|:---|
| `[MPU] ERROR: MPU6050 not detected` in Serial | Wiring issue | Check SDA→21, SCL→22, AD0→GND |
| LED fast-blinks after boot | MPU6050 not found | As above |
| Drift when held still | Calibration captured movement | Hold ESP32 flat during the 1 s blink phase |
| `FPV-Drone-Ctrl` WiFi not appearing | ESP32 not booted fully | Wait ~5 s; check LED is solid ON |
| "Could not connect to ws://…" | Wrong IP / Laptop A not on hotspot | Verify network connection; try `ping 192.168.4.1` |
| Upload fails / "Connecting..." stalls | Not in bootloader mode | Hold **BOOT** button while clicking Upload |
| USB: "Web Serial not supported" | Wrong browser | Use Chrome, Edge, or Brave |
| USB: No ports in dialog | Missing USB driver | Install [CP2102](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers) or [CH340](https://www.wch-ic.com/downloads/CH341SER_EXE.html) driver |
| Drone twitches while still | Deadzone too small | Increase `DEADZONE_DEG` to `5.0` in the `.ino` |
| USB Serial: disconnects if Serial Monitor is open | Port conflict | Close Arduino Serial Monitor before using the browser |

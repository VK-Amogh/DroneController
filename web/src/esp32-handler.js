// esp32-handler.js  v3.0  — Dual Transport: WiFi WebSocket  +  USB Serial
//
// Two ways to connect the ESP32 motion controller:
//
//   🌐 WiFi (WebSocket)  — recommended for cross-laptop use
//       - ESP32 creates a hotspot "FPV-Drone-Ctrl" (or joins your router)
//       - Enter its IP address in the connect dialog
//       - Zero-driver: works in all browsers including Firefox
//
//   🔌 USB Serial (Web Serial API)  — for single-laptop use
//       - Plug ESP32 into the simulator laptop via USB
//       - Click "USB" in the connection dialog
//       - Requires Chrome / Edge / Brave only

export class ESP32Handler {
  /**
   * @param {object}   physics   — DronePhysics instance
   * @param {function} onReset   — called when dual-button reset is triggered
   */
  constructor(physics, onReset = () => {}) {
    this.physics = physics;
    this.onReset = onReset;

    // ── Connection state ────────────────────────────────────────────────────
    this.transport = null;    // 'ws' | 'serial' | null
    this.connected = false;

    // WebSocket
    this._ws      = null;

    // Web Serial
    this._port    = null;
    this._reader  = null;
    this._reading = false;

    // ── Input state ─────────────────────────────────────────────────────────
    this.state = {
      pitch:  0,      // -1 … +1
      roll:   0,      // -1 … +1
      yaw:    0,      // -1 … +1
      up:     false,
      down:   false,
      active: false,  // true while live packets are arriving
    };

    // ── Telemetry stats ─────────────────────────────────────────────────────
    this.lastPacketTime = 0;
    this.packetCount    = 0;
    this.packetsPerSec  = 0;
    this._fpsTimer      = performance.now();

    // ── Status callback ──────────────────────────────────────────────────────
    // Signature: (status: string, handler: this) => void
    //   status values: 'CONNECTED_WS' | 'CONNECTED_SERIAL' | 'DISCONNECTED'
    this.onStatusChange = null;

    // Physical USB unplug detection
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', (e) => {
        if (this._port && e.target === this._port) {
          this._handleDisconnect('USB unplugged');
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Connect over WiFi WebSocket.  wsUrl = "ws://192.168.4.1:81" */
  async connectWiFi(wsUrl) {
    if (this.connected) await this.disconnect();

    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        const timeoutId = setTimeout(() => {
          ws.close();
          this._handleDisconnect('WiFi connect timeout');
          resolve(false);
        }, 8000);

        ws.onopen = () => {
          clearTimeout(timeoutId);
          this._ws = ws;
          this.transport = 'ws';
          this.connected = true;
          this._notifyStatus('CONNECTED_WS');
          resolve(true);
        };

        ws.onmessage = (e) => {
          const text = typeof e.data === 'string'
            ? e.data
            : new TextDecoder().decode(e.data);
          // Each WS message from the ESP32 is one complete JSON line
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (t.length > 0) this._parsePacket(t);
          }
        };

        ws.onerror = (e) => {
          clearTimeout(timeoutId);
          console.warn('ESP32 WebSocket error:', e);
        };

        ws.onclose = () => {
          clearTimeout(timeoutId);
          if (this.connected && this.transport === 'ws') {
            this._handleDisconnect('WebSocket closed');
          }
          resolve(false);
        };
      } catch (err) {
        console.error('connectWiFi error:', err);
        this._handleDisconnect(err.message);
        resolve(false);
      }
    });
  }

  /** Connect over USB Serial (Web Serial API — Chrome/Edge/Brave only). */
  async connectSerial() {
    if (!('serial' in navigator)) {
      alert(
        'Web Serial API is not supported.\n' +
        'For USB connection, use Chrome, Edge, or Brave.\n' +
        'Or use the WiFi / WebSocket option instead.'
      );
      return false;
    }
    if (this.connected) await this.disconnect();

    try {
      this._port = await navigator.serial.requestPort();
      await this._port.open({ baudRate: 115200 });
      this.transport = 'serial';
      this.connected = true;
      this._notifyStatus('CONNECTED_SERIAL');
      this._readSerialLoop().catch((err) => {
        if (this.connected) {
          console.error('Serial loop error:', err);
          this._handleDisconnect('Serial read error');
        }
      });
      return true;
    } catch (err) {
      if (!err.message?.includes('No port selected')) {
        console.warn('connectSerial error:', err);
      }
      this._handleDisconnect(err.message || 'Serial connect failed');
      return false;
    }
  }

  /** Disconnect whichever transport is active. */
  async disconnect() {
    this.connected = false;

    // Close WebSocket
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }

    // Cancel Serial reader
    if (this._reader) {
      try { await this._reader.cancel(); } catch (_) {}
      this._reader = null;
    }
    if (this._port) {
      await new Promise(r => setTimeout(r, 60));
      try { await this._port.close(); } catch (_) {}
      this._port = null;
    }

    this._handleDisconnect('Disconnected by user');
  }

  /**
   * Returns the current input state.
   * Watchdog: if no packet for >300 ms, neutralises inputs automatically.
   */
  read() {
    if (this.state.active && performance.now() - this.lastPacketTime > 300) {
      this.state.active = false;
      this.state.pitch  = 0;
      this.state.roll   = 0;
      this.state.yaw    = 0;
      this.state.up     = false;
      this.state.down   = false;
    }
    return this.state;
  }

  /** For unit tests / offline demo without hardware. */
  simulatePacket(jsonStr) {
    this.connected = true;
    this._parsePacket(jsonStr);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════════════

  _handleDisconnect(reason) {
    this.connected    = false;
    this.transport    = null;
    this.state.active = false;
    this.state.pitch  = 0;
    this.state.roll   = 0;
    this.state.yaw    = 0;
    this.state.up     = false;
    this.state.down   = false;
    this._notifyStatus('DISCONNECTED');
    console.info('[ESP32] Disconnected:', reason);
  }

  _notifyStatus(status) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(status, this);
    }
  }

  // Serial read loop (USB mode)
  async _readSerialLoop() {
    if (this._reading) return;
    this._reading = true;

    const textDecoder = new TextDecoderStream();
    const pipePromise = this._port.readable.pipeTo(textDecoder.writable);
    this._reader = textDecoder.readable.getReader();
    let buffer = '';

    try {
      while (this.connected) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (t) this._parsePacket(t);
          }
        }
      }
    } catch (err) {
      if (this.connected) {
        console.warn('[ESP32] Serial read error:', err.message);
        this._handleDisconnect('Serial read error');
      }
    } finally {
      try { this._reader?.releaseLock(); } catch (_) {}
      this._reader = null;
      pipePromise.catch(() => {});
      this._reading = false;
    }
  }

  // JSON packet parser — shared by WiFi and Serial transports
  _parsePacket(line) {
    if (!line || line[0] !== '{' || line[line.length - 1] !== '}') return;

    let data;
    try { data = JSON.parse(line); } catch { return; }

    // Skip boot/cal/error non-telemetry messages
    if (data.boot !== undefined || data.cal !== undefined || data.hello !== undefined) {
      if (data.err) console.warn('[ESP32 fw]', data.err);
      return;
    }

    // Clamp to [-1, 1]
    const clamp = (v) => Math.max(-1.0, Math.min(1.0, v));

    if (typeof data.p === 'number' && isFinite(data.p)) this.state.pitch = clamp(data.p);
    if (typeof data.r === 'number' && isFinite(data.r)) this.state.roll  = clamp(data.r);
    if (typeof data.y === 'number' && isFinite(data.y)) this.state.yaw   = clamp(data.y);

    this.state.up   = (data.u === 1 || data.u === true);
    this.state.down = (data.d === 1 || data.d === true);

    this.state.active   = true;
    this.lastPacketTime = performance.now();
    this.packetCount++;

    const now = performance.now();
    if (now - this._fpsTimer >= 1000) {
      this.packetsPerSec = this.packetCount;
      this.packetCount   = 0;
      this._fpsTimer     = now;
    }

    if (data.rst === 1) {
      try { this.onReset(); } catch (e) { console.error('onReset error:', e); }
    }
  }
}

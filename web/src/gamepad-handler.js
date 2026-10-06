// gamepad-handler.js
// Gamepad API support: standard RC mapping (Mode 2).
//   Left stick  Y → climb / descend (auto-hover when centered)
//   Left stick  X → yaw
//   Right stick Y → forward / backward, X → strafe left / right
// When any stick is moved past a threshold the gamepad owns the controls;
// after ~3s without stick input the keyboard takes back over.

export class GamepadHandler {
  constructor(physics) {
    this.physics = physics;
    this.active = false;      // a pad is connected
    this.driving = false;     // pad currently owns the sticks
    this._idleTime = 0;
    this._padIndex = null;

    window.addEventListener('gamepadconnected', (e) => {
      this._padIndex = e.gamepad.index;
      this.active = true;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this._padIndex) {
        this._padIndex = null;
        this.active = false;
        this.driving = false;
      }
    });
  }

  // Returns { throttle, yaw, pitch, roll } or null when the keyboard owns input.
  read() {
    if (!this.active || this._padIndex === null) return null;
    const pad = navigator.getGamepads?.()[this._padIndex];
    if (!pad) return null;

    const dz = 0.15; // generous deadzone — cheap pads rest off-center
    const ax = (i) => {
      const v = pad.axes[i] ?? 0;
      return Math.abs(v) < dz ? 0 : v;
    };

    const yaw = ax(0);            // left X
    const throttleRaw = ax(1);    // left Y (up = -1)
    const roll = ax(2);           // right X
    const pitchRaw = ax(3);       // right Y (up = -1)

    // Only seize the controls on a deliberate stick deflection, not noise.
    const moved =
      Math.abs(yaw) > 0.25 || Math.abs(throttleRaw) > 0.25 ||
      Math.abs(roll) > 0.25 || Math.abs(pitchRaw) > 0.25;

    if (moved) {
      this.driving = true;
      this._idleTime = 0;
    } else if (this.driving) {
      this._idleTime += 1 / 60;
      if (this._idleTime > 3) this.driving = false; // hand back to keyboard
    }

    if (!this.driving) return null;

    return {
      vertical: -throttleRaw,        // stick up = climb
      yaw,
      pitch: pitchRaw,               // stick up (-1) = forward, same as W
      roll,
    };
  }
}

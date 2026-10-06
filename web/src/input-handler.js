// input-handler.js
// Arcade keyboard mapping:
//   W / S        → fly forward / backward (spring-centered)
//   A / D        → strafe left / right (spring-centered)
//   Q / E        → yaw left / right (spring-centered)
//   Arrow Up/Dn  → move up / down (spring-centered; release = auto-hover)
//   Arrow L/R    → strafe left / right (same as A/D)
//   1 / 2 / 3    → Angle / Horizon / Acro flight modes

export class InputHandler {
  constructor(physics) {
    this.physics = physics;
    this._keys = {};

    // Smooth axis values (all spring back to center when released)
    this._vertical = 0;
    this._yaw      = 0;
    this._pitch    = 0;
    this._roll     = 0;

    this._axisSpeed  = 5.5;  // fast, responsive ramp-up
    this._axisDecay  = 7.0;  // smooth, crisp return to center

    window.addEventListener('keydown', e => {
      this._keys[e.key] = true;
      this._handleToggle(e.key);
      if (e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      this._keys[e.key] = false;
    });

    // If the window loses focus while a key is held, clear keys
    const clearKeys = () => { this._keys = {}; };
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearKeys();
    });
  }

  _handleToggle(key) {
    switch (key) {
      case '1': this.physics.currentMode = 'Angle';   break;
      case '2': this.physics.currentMode = 'Horizon'; break;
      case '3': this.physics.currentMode = 'Acro';    break;
    }
  }

  _springAxis(current, neg, pos, ramp, decay) {
    if (pos) return Math.min(1, current + ramp);
    if (neg) return Math.max(-1, current - ramp);
    let v = current * Math.max(0, 1 - decay * 2.2);
    return Math.abs(v) < 0.008 ? 0 : v;
  }

  update(dt) {
    const k = this._keys;
    const ramp  = this._axisSpeed * dt;
    const decay = this._axisDecay * dt;
    const down = (...keys) => keys.some((key) => this._keys[key]);

    // W forward (−1) / S backward (+1)
    this._pitch = this._springAxis(this._pitch,
      down('w', 'W'), down('s', 'S'), ramp, decay);

    // A strafe left (−1), D strafe right (+1) — perfectly balanced with pitch
    this._roll = this._springAxis(this._roll,
      down('a', 'A'), down('d', 'D'), ramp, decay);

    // Q / ArrowRight rotate left (−1), E / ArrowLeft rotate right (+1) around vertical axis (inverted arrow keys)
    this._yaw = this._springAxis(this._yaw,
      down('q', 'Q', 'ArrowRight'), down('e', 'E', 'ArrowLeft'), ramp * 1.4, decay);

    // ArrowUp climb (+1) / ArrowDown descend (−1); release = hover
    this._vertical = this._springAxis(this._vertical,
      down('ArrowDown'), down('ArrowUp'), ramp * 1.2, decay);

    // Push to physics
    this.physics.pitchInput    = this.physics.applyDeadzone(this._pitch);
    this.physics.rollInput     = this.physics.applyDeadzone(this._roll);
    this.physics.yawInput      = this.physics.applyDeadzone(this._yaw);
    this.physics.verticalInput = this.physics.applyDeadzone(this._vertical);
  }
}

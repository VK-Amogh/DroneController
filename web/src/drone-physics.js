// drone-physics.js
// Arcade-style drone physics: direct velocity control with auto-hover.
//   pitch/roll input → horizontal acceleration (tilts the frame for feel)
//   vertical input   → vertical velocity servo (release = hover in place)
//   yaw input        → direct turn rate
// No gravity drift: when no key is held the drone holds position.

export const FlightMode = {
  Angle: 'Angle',
  Horizon: 'Horizon',
  Acro: 'Acro',
};

export class DronePhysics {
  constructor() {
    // -- Movement tuning --
    this.moveAccel     = 38;    // m/s² responsive horizontal acceleration
    this.maxSpeed      = 30;    // m/s smooth cruising top speed
    this.activeBraking = 4.2;   // active deceleration into hover when keys released
    this.drag          = 0.85;  // aerodynamic air drag
    this.climbRate     = 14;    // m/s vertical speed
    this.climbResponse = 7.5;   // fast, stable vertical response
    this.yawRate       = 3.2;   // rad/s keyboard turn rate

    // -- Tilt (visual + feel) --
    this.maxTiltAngle  = 26;    // degrees of visual bank (sleek, authentic racing quad tilt)
    this.stabilizationStrength = 18;
    this.stabilizationDamping  = 5.5;
    this.pitchTorque   = 18;
    this.rollTorque    = 18;
    this.angularDamping = 0.6;
    this.inputDeadzone = 0.04;
    this.acroExpo      = 0.45;

    // -- State -- default to Angle (self-leveling arcade flight)
    this.currentMode = FlightMode.Angle;

    // -- Physics state (integrated each tick) --
    this.position    = { x: 0, y: 0.2, z: 0 };   // starts landed on the pad
    this.velocity    = { x: 0, y: 0, z: 0 };
    this.rotation    = { x: 0, y: 0, z: 0 };   // Euler angles (radians)
    this.angularVel  = { x: 0, y: 0, z: 0 };   // radians/s local

    // -- Raw inputs --
    //   pitchInput: -1 = fly forward (W), +1 = fly backward (S)
    //   rollInput:  -1 = strafe left (A),  +1 = strafe right (D)
    //   yawInput:   -1 = turn left (Q),    +1 = turn right (E)
    //   verticalInput: +1 = climb (↑),     -1 = descend (↓), 0 = hover
    this.pitchInput    = 0;
    this.rollInput     = 0;
    this.yawInput      = 0;
    this.verticalInput = 0;
    // Display/prop-spin value derived from verticalInput (0..1)
    this.throttleInput = 0.45;

    // -- Aim & Orientation (free full-axis 3D aiming) --
    this.aimPitch      = 0;     // vertical look/aim angle in radians (-1.48 to +1.48, ~-85° to +85°)

    // -- Spawn / landing state --
    this.startY  = 0.2;

    // Optional terrain height function: (x, z) => ground y at that point
    this.groundHeight = null;
  }

  reset() {
    this.position    = { x: 0, y: this.startY, z: 0 };
    this.velocity    = { x: 0, y: 0, z: 0 };
    this.rotation    = { x: 0, y: 0, z: 0 };
    this.angularVel  = { x: 0, y: 0, z: 0 };
    this.pitchInput = this.rollInput = this.yawInput = this.verticalInput = 0;
    this.throttleInput = 0.45;
    this.aimPitch    = 0;
  }

  applyDeadzone(v) {
    const dz = this.inputDeadzone;
    if (Math.abs(v) < dz) return 0;
    return Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz));
  }

  applyExpo(v, expo) {
    return (expo * v * v * v) + ((1 - expo) * v);
  }

  // Convert Euler angle from 0-2π to -π..π
  convertAngle(rad) {
    return rad > Math.PI ? rad - 2 * Math.PI : rad;
  }

  update(dt) {
    // ---- Yaw (direct turn rate) ----
    const yawTarget = this.applyExpo(this.yawInput, this.acroExpo) * this.yawRate;
    this.angularVel.y += (yawTarget - this.angularVel.y) * Math.min(1, 10 * dt);
    this.rotation.y += this.angularVel.y * dt;
    this.rotation.y = ((this.rotation.y % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // ---- Pitch & roll tilt (mode-dependent feel) ----
    switch (this.currentMode) {
      case FlightMode.Acro:    this._handleAcro(dt);    break;
      case FlightMode.Horizon: this._handleHorizon(dt); break;
      default:                 this._handleAngle(dt);   break;
    }

    this.angularVel.x *= (1 - this.angularDamping * dt * 0.5);
    this.angularVel.z *= (1 - this.angularDamping * dt * 0.5);

    this.rotation.x += this.angularVel.x * dt;
    this.rotation.z += this.angularVel.z * dt;
    this.rotation.x = Math.max(-Math.PI * 0.9, Math.min(Math.PI * 0.9, this.rotation.x));
    this.rotation.z = Math.max(-Math.PI * 0.9, Math.min(Math.PI * 0.9, this.rotation.z));

    // ---- True 3D movement (flies in the exact 3D vector the mousepad is pointing) ----
    const yaw = this.rotation.y;
    const pitch = this.aimPitch || 0;
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // 3D forward unit vector: -Z is north at yaw 0, +Y is up, +X is east/right
    const fwdX = -Math.sin(yaw) * cosP;
    const fwdY = sinP;
    const fwdZ = -Math.cos(yaw) * cosP;

    // Horizontal strafe vector (perpendicular to yaw)
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const fwdAmt   = -this.pitchInput;  // W (pitch -1) → +1 forward
    const rightAmt = this.rollInput;     // D (+1) / A (-1)

    const hasDirectionalInput = (Math.abs(fwdAmt) > 0.02 || Math.abs(rightAmt) > 0.02);
    const hasVerticalInput    = (Math.abs(this.verticalInput) > 0.02);

    if (hasDirectionalInput) {
      // Accelerate in full 3D space along the mousepad aim vector
      this.velocity.x += (fwdX * fwdAmt + rightX * rightAmt) * this.moveAccel * dt;
      this.velocity.y += (fwdY * fwdAmt) * this.moveAccel * dt;
      this.velocity.z += (fwdZ * fwdAmt + rightZ * rightAmt) * this.moveAccel * dt;

      // Natural aerodynamic drag
      this.velocity.x *= (1 - this.drag * dt);
      this.velocity.y *= (1 - this.drag * 0.45 * dt);
      this.velocity.z *= (1 - this.drag * dt);
    } else {
      // Smooth active braking into rock-solid hover
      const brake = Math.min(1, this.activeBraking * dt);
      this.velocity.x *= (1 - brake);
      this.velocity.z *= (1 - brake);
      if (Math.abs(this.velocity.x) < 0.03) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.03) this.velocity.z = 0;
    }

    // Keyboard vertical input (ArrowUp / ArrowDown) overrides or supplements collective climb/descend
    if (hasVerticalInput) {
      const targetVy = this.verticalInput * this.climbRate;
      this.velocity.y += (targetVy - this.velocity.y) * Math.min(1, this.climbResponse * dt);
    } else if (!hasDirectionalInput) {
      // Auto-hover in place when neither W/S nor ArrowUp/Dn is pressed
      const brakeY = Math.min(1, this.activeBraking * dt);
      this.velocity.y *= (1 - brakeY);
      if (Math.abs(this.velocity.y) < 0.03) this.velocity.y = 0;
    }

    // Smooth 3D top speed limiter across all 3 axes
    const currentSpeed = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
    if (currentSpeed > this.maxSpeed) {
      const scale = this.maxSpeed / currentSpeed;
      this.velocity.x *= scale;
      this.velocity.y *= scale;
      this.velocity.z *= scale;
    }

    // Display value for HUD / prop spin
    this.throttleInput = Math.min(1, Math.max(0, 0.45 + (this.verticalInput * 0.45) + (Math.abs(fwdAmt) * 0.35)));

    // ---- Integrate position ----
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // ---- Terrain contact: never fall below ground ----
    const ground = this.groundHeight
      ? this.groundHeight(this.position.x, this.position.z)
      : 0;
    const minY = ground + this.startY;
    if (this.position.y <= minY) {
      this.position.y = minY;
      if (this.velocity.y < 0) this.velocity.y = 0;

      // Aerodynamic takeoff lift when forward thrust is commanded on the ground
      if (fwdAmt > 0.05 && this.velocity.y <= 0.6) {
        this.velocity.y = Math.max(this.velocity.y, 4.5 + (this.aimPitch > 0 ? this.aimPitch * 10 : 0));
      }

      // Ground friction only holds drone when completely idle
      if (!hasDirectionalInput && !hasVerticalInput) {
        const friction = Math.min(1, 6.0 * dt);
        this.velocity.x *= (1 - friction);
        this.velocity.z *= (1 - friction);
      }
    }
  }

  _handleAcro(dt) {
    const pp = this.applyExpo(this.pitchInput, this.acroExpo);
    const rp = this.applyExpo(this.rollInput, this.acroExpo);
    this.angularVel.x += pp * this.pitchTorque * dt;
    this.angularVel.z -= rp * this.rollTorque * dt;
  }

  _handleAngle(dt) {
    // Drone tilts nose down/up matching aim pitch and W/S keys
    const aimTilt   = -this.aimPitch * 0.70;
    const keyTilt   = this.pitchInput * (this.maxTiltAngle * Math.PI / 180);
    const targetPitch = Math.max(-1.45, Math.min(1.45, aimTilt + keyTilt));

    // Roll leans naturally into yaw turns and strafing
    const keyRoll   = -this.rollInput * (this.maxTiltAngle * Math.PI / 180);
    const turnBank  = -this.angularVel.y * 0.14;
    const targetRoll  = Math.max(-0.85, Math.min(0.85, keyRoll + turnBank));

    const pitchErr = targetPitch - this.convertAngle(this.rotation.x);
    const rollErr  = targetRoll  - this.convertAngle(this.rotation.z);

    const pitchPD = (pitchErr * this.stabilizationStrength) - (this.angularVel.x * this.stabilizationDamping);
    const rollPD  = (rollErr  * this.stabilizationStrength) - (this.angularVel.z * this.stabilizationDamping);

    this.angularVel.x += pitchPD * dt;
    this.angularVel.z += rollPD  * dt;
  }

  _handleHorizon(dt) {
    const pp = this.applyExpo(this.pitchInput, this.acroExpo);
    const rp = this.applyExpo(this.rollInput, this.acroExpo);
    this.angularVel.x += pp * this.pitchTorque * dt;
    this.angularVel.z -= rp * this.rollTorque * dt;

    // P-only stabilization spring
    const curPitch = this.convertAngle(this.rotation.x);
    const curRoll  = this.convertAngle(this.rotation.z);
    this.angularVel.x += -curPitch * this.stabilizationStrength * 0.5 * dt;
    this.angularVel.z += -curRoll  * this.stabilizationStrength * 0.5 * dt;
  }

  get speed() {
    const v = this.velocity;
    return Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
  }

  get altitude() {
    return this.position.y - this.startY;
  }
}

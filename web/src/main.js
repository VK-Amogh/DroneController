// main.js — FPV Drone Simulator entry point

import * as THREE from 'three';
import { buildScene, terrainHeight } from './scene-builder.js';
import { loadDroneModel } from './glb-loader.js';
import { DronePhysics, FlightMode } from './drone-physics.js';
import { InputHandler } from './input-handler.js';
import { GamepadHandler } from './gamepad-handler.js';
import { ESP32Handler } from './esp32-handler.js';
import { RingCourse } from './rings.js';
import { createPostFX } from './postfx.js';

// ============================================================
// DOM references
// ============================================================
const splash      = document.getElementById('splash');
const loadingBar  = document.getElementById('loading-bar');
const loadingText = document.getElementById('loading-text');
const launchBtn   = document.getElementById('launch-btn');
const canvas      = document.getElementById('sim-canvas');
const osd         = document.getElementById('osd');
const osdMode     = document.getElementById('osd-mode');
const osdThr      = document.getElementById('osd-thr');
const osdAlt      = document.getElementById('osd-alt');
const osdSpd      = document.getElementById('osd-spd');
const osdCam      = document.getElementById('osd-cam');
const osdRings    = document.getElementById('osd-rings');
const osdTime     = document.getElementById('osd-time');
const osdBest     = document.getElementById('osd-best');
const osdPad      = document.getElementById('osd-pad');
const esp32Btn    = document.getElementById('esp32-btn');
const esp32BtnPanel = document.getElementById('esp32-btn-panel');
const finishBanner = document.getElementById('finish-banner');
const finishTime  = document.getElementById('finish-time');
const controlsPanel = document.getElementById('controls-panel');

let thrFill;

// ============================================================
// Simulator state
// ============================================================
export const CameraView = {
  Chase: 'chase',
  Close: 'close',
  FPV: 'fpv'
};

let renderer, scene, droneGroup, droneProps, propGlow;
let physics, input, gamepad, rings, postfx, world, esp32;
let camera3p, cameraFPV, activeCamera;
let cameraView = CameraView.Chase;
let isFPV = false;
let running = false;
let prevTime;

const camTarget = new THREE.Vector3();
let chaseYaw = 0;
let chaseDist = 6.5;
let chaseHeight = 2.4;
let chaseBank = 0;
let fpvTiltDeg = 25; // standard FPV racing quad uptilt angle

// Touchpad / Mouse steering and look state
let isOrbitDragging = false;
let camPitchOffset = 0; // vertical camera tilt
let lastPointerX = 0;
let lastPointerY = 0;

// ============================================================
// Setup
// ============================================================
function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
}

function setupCameras() {
  const aspect = window.innerWidth / window.innerHeight;
  // Expansive 4000m far plane: view miles of infinite procedural terrain without clipping
  camera3p = new THREE.PerspectiveCamera(60, aspect, 0.1, 4000);
  camera3p.position.set(0, 2.6, 6.5);
  cameraFPV = new THREE.PerspectiveCamera(100, aspect, 0.05, 4000);
  activeCamera = camera3p;
  resetCamera();
}

function cycleCameraView() {
  if (cameraView === CameraView.Chase) {
    cameraView = CameraView.Close;
  } else if (cameraView === CameraView.Close) {
    cameraView = CameraView.FPV;
  } else {
    cameraView = CameraView.Chase;
  }
  isFPV = (cameraView === CameraView.FPV);
  activeCamera = isFPV ? cameraFPV : camera3p;
  postfx.setCamera(activeCamera);
}

function resetCamera() {
  chaseYaw = physics ? physics.rotation.y : 0;
  chaseBank = 0;
  chaseDist = (cameraView === CameraView.Close) ? 2.2 : 6.5;
  chaseHeight = (cameraView === CameraView.Close) ? 0.78 : 2.4;
  camPitchOffset = 0;
  if (physics) physics.aimPitch = 0;
  if (world && physics) world.update(physics.position, true);
  isOrbitDragging = false;
  camTarget.set(0, 0.4, -2.4);
  if (camera3p) {
    camera3p.position.set(0, chaseHeight, chaseDist);
    camera3p.lookAt(camTarget);
    camera3p.fov = (cameraView === CameraView.Close) ? 65 : 60;
    camera3p.updateProjectionMatrix();
  }
}

function setupThrottleBar() {
  const wrap = document.createElement('div');
  wrap.id = 'throttle-bar-wrap';
  wrap.innerHTML = `
    <div class="thr-label">THR</div>
    <div class="thr-track"><div class="thr-fill" style="height:0%"></div></div>
    <div class="thr-label" id="thr-pct">0%</div>
  `;
  document.getElementById('app').appendChild(wrap);
  thrFill = wrap.querySelector('.thr-fill');
}

// ============================================================
// Real loading sequence
// ============================================================
async function loadAll() {
  const setProgress = (pct, msg) => {
    loadingBar.style.width = pct + '%';
    loadingText.textContent = msg;
  };

  setupRenderer();

  setProgress(8, 'Building terrain & sky…');
  const built = await buildScene(renderer, (f) =>
    setProgress(8 + f * 55, 'Building terrain & sky…'));
  scene = built.scene;
  world = built.world;

  setProgress(68, 'Loading drone model…');
  const drone = await loadDroneModel((f) =>
    setProgress(68 + f * 22, 'Loading drone model…'));
  droneGroup = drone.group;
  droneProps = drone.props;
  propGlow = drone.propGlow;
  scene.add(droneGroup);

  setProgress(94, 'Calibrating flight controller…');
  setupCameras();
  physics = new DronePhysics();
  physics.groundHeight = terrainHeight;
  input = new InputHandler(physics);
  gamepad = new GamepadHandler(physics);
  esp32 = new ESP32Handler(physics, () => {
    physics.reset();
    resetCamera();
    rings.reset();
    finishBanner.classList.add('hidden');
  });
  setupESP32Buttons();
  rings = new RingCourse(scene);
  postfx = createPostFX(renderer, scene, activeCamera);
  setupThrottleBar();
  setupLookAround();
  window.sim = {
    physics,
    rings,
    world,
    gamepad,
    esp32,
    camera3p,
    cameraFPV,
    getCameraView: () => cameraView,
    setCameraView: (v) => {
      cameraView = v;
      isFPV = (v === CameraView.FPV);
      activeCamera = isFPV ? cameraFPV : camera3p;
      postfx.setCamera(activeCamera);
    },
    cycleCameraView,
    getIsFPV: () => isFPV,
    getChaseBank: () => chaseBank,
    getChaseYaw: () => chaseYaw,
    getChaseDist: () => chaseDist,
    getCamPitchOffset: () => camPitchOffset,
    setCamPitchOffset: (p) => {
      camPitchOffset = p;
      if (physics) physics.aimPitch = -p;
    },
    getAimPitch: () => (physics ? physics.aimPitch : 0),
    setAimPitch: (p) => {
      if (physics) physics.aimPitch = p;
      camPitchOffset = -p;
    },
    applyMouseLook: (dx, dy) => applyMouseLookGlobal(dx, dy),
    getFpvTilt: () => fpvTiltDeg,
    getWorld: () => world,
    getTerrainHeight: (x, z) => terrainHeight(x, z)
  }; // debug/test hook

  setProgress(100, 'Ready for takeoff!');
  launchBtn.classList.remove('hidden');
}

// ============================================================
// ESP32 Connection Dialog  (WiFi WebSocket  OR  USB Serial)
// ============================================================
function setupESP32Buttons() {

  // -- Status label helper --
  const updateUI = (status) => {
    const isConn   = status === 'CONNECTED_WS' || status === 'CONNECTED_SERIAL';
    const transport = status === 'CONNECTED_WS' ? '📶 WiFi' : status === 'CONNECTED_SERIAL' ? '🔌 USB' : '';
    const label     = isConn ? `🎮 ESP32 ${transport}` : '🎮 CONNECT ESP32';
    if (esp32Btn)     { esp32Btn.textContent = label;     esp32Btn.classList.toggle('connected', isConn); }
    if (esp32BtnPanel){ esp32BtnPanel.textContent = isConn ? `ESP32 ${transport}` : 'ESP32: Connect';
                        esp32BtnPanel.classList.toggle('connected', isConn); }
  };

  if (esp32) esp32.onStatusChange = updateUI;

  // -- Connection dialog modal --
  function showConnectDialog() {
    // Remove any existing dialog first
    document.getElementById('esp32-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'esp32-modal';
    modal.innerHTML = `
      <div class="esp32-modal-backdrop"></div>
      <div class="esp32-modal-box">
        <h3>🎮 Connect ESP32 Controller</h3>
        <p class="esp32-modal-sub">Choose how your ESP32 is connected to this laptop:</p>

        <div class="esp32-modal-tabs">
          <button class="esp32-tab active" id="tab-wifi">📶 WiFi (Wireless)</button>
          <button class="esp32-tab"         id="tab-usb" >🔌 USB Cable</button>
        </div>

        <div id="pane-wifi" class="esp32-pane">
          <p>The ESP32 creates a WiFi hotspot <strong>"FPV-Drone-Ctrl"</strong>.<br>
             Connect this laptop to that hotspot, then click Connect.</p>
          <label>WebSocket URL
            <input id="esp32-ws-url" type="text" value="ws://192.168.4.1:81"
                   placeholder="ws://192.168.4.1:81" spellcheck="false" />
          </label>
          <p class="esp32-modal-hint">💡 If using STA mode (router), enter the IP shown on the Serial Monitor.</p>
          <button class="esp32-connect-btn" id="do-wifi-connect">Connect via WiFi</button>
        </div>

        <div id="pane-usb" class="esp32-pane hidden">
          <p>Plug the ESP32 into <strong>this laptop</strong> with a USB cable.<br>
             The browser will ask you to pick a COM port.</p>
          <p class="esp32-modal-hint">⚠️ USB Serial requires Chrome, Edge, or Brave. Not Firefox.</p>
          <button class="esp32-connect-btn" id="do-usb-connect">Connect via USB</button>
        </div>

        <button class="esp32-modal-close" id="esp32-modal-close">✕ Cancel</button>
      </div>`;

    document.body.appendChild(modal);

    // Tab switching
    modal.querySelector('#tab-wifi').addEventListener('click', () => {
      modal.querySelector('#tab-wifi').classList.add('active');
      modal.querySelector('#tab-usb').classList.remove('active');
      modal.querySelector('#pane-wifi').classList.remove('hidden');
      modal.querySelector('#pane-usb').classList.add('hidden');
    });
    modal.querySelector('#tab-usb').addEventListener('click', () => {
      modal.querySelector('#tab-usb').classList.add('active');
      modal.querySelector('#tab-wifi').classList.remove('active');
      modal.querySelector('#pane-usb').classList.remove('hidden');
      modal.querySelector('#pane-wifi').classList.add('hidden');
    });

    // WiFi connect
    modal.querySelector('#do-wifi-connect').addEventListener('click', async () => {
      const url = modal.querySelector('#esp32-ws-url').value.trim();
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        alert('URL must start with ws:// (e.g. ws://192.168.4.1:81)');
        return;
      }
      modal.querySelector('#do-wifi-connect').textContent = 'Connecting…';
      modal.querySelector('#do-wifi-connect').disabled = true;
      const ok = await esp32.connectWiFi(url);
      if (ok) { modal.remove(); } else {
        modal.querySelector('#do-wifi-connect').textContent = 'Connect via WiFi';
        modal.querySelector('#do-wifi-connect').disabled = false;
        alert(`Could not connect to ${url}\n\nCheck:\n• ESP32 is powered on\n• This laptop is on the ESP32 hotspot WiFi\n• URL/port is correct`);
      }
    });

    // USB Serial connect
    modal.querySelector('#do-usb-connect').addEventListener('click', async () => {
      modal.querySelector('#do-usb-connect').textContent = 'Connecting…';
      modal.querySelector('#do-usb-connect').disabled = true;
      const ok = await esp32.connectSerial();
      if (ok) { modal.remove(); } else {
        modal.querySelector('#do-usb-connect').textContent = 'Connect via USB';
        modal.querySelector('#do-usb-connect').disabled = false;
      }
    });

    // Close / cancel
    const closeModal = () => modal.remove();
    modal.querySelector('#esp32-modal-close').addEventListener('click', closeModal);
    modal.querySelector('.esp32-modal-backdrop').addEventListener('click', closeModal);
  }

  // -- Button click handlers --
  const handleClick = async (e) => {
    e.stopPropagation();
    if (!esp32) return;
    if (esp32.connected) {
      await esp32.disconnect();
    } else {
      showConnectDialog();
    }
  };

  if (esp32Btn)      esp32Btn.addEventListener('click', handleClick);
  if (esp32BtnPanel) esp32BtnPanel.addEventListener('click', handleClick);
}

// ============================================================
// Free Multi-Axis Touchpad & Mouse Steering
// ============================================================
let applyMouseLookGlobal = () => {};

function setupLookAround() {
  function applyMouseLook(dx, dy) {
    if (!physics || !running) return;

    // SENSITIVITY:
    // dx: horizontal yaw turn around vertical Y-axis
    // dy: vertical pitch up/down around horizontal X-axis
    const sensYaw   = 0.0032;
    const sensPitch = 0.0028;
    const sensRoll  = 0.0020;

    // 1) YAW: Moving mousepad to the right turns the drone RIGHT (continuous 360° uninhibited rotation)
    physics.rotation.y -= dx * sensYaw;
    physics.rotation.y = ((physics.rotation.y % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // Dynamic yaw angular velocity feedback for authentic banking and turning inertia
    physics.angularVel.y = -(dx * sensYaw) * 12.0;

    // 2) ROLL: Diagonal swipes or sharp lateral turns induce dynamic banking roll around Z-axis
    physics.angularVel.z += (dx * sensRoll) * 14.0;

    // 3) PITCH: Moving mousepad forward/up (dy < 0) aims UP into the sky (+aimPitch)
    // Moving mousepad backward/down (dy > 0) aims DOWN towards the ground (-aimPitch)
    // FULL FREE VERTICAL RANGE: ±1.48 rad (~85° up/down, near-vertical zenith and nadir!)
    physics.aimPitch = (physics.aimPitch || 0) - dy * sensPitch;
    physics.aimPitch = Math.max(-1.48, Math.min(1.48, physics.aimPitch));

    // Keep camPitchOffset aligned for 3rd person camera orbit
    camPitchOffset = -physics.aimPitch;
  }

  applyMouseLookGlobal = applyMouseLook;

  const onPointerDown = (e) => {
    if (splash && !splash.classList.contains('hidden')) return;
    if (e.target?.closest?.('#controls-panel') || e.target?.closest?.('#launch-btn') || e.target?.closest?.('#osd-cam')) return;

    isOrbitDragging = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    canvas.classList.add('dragging');

    // Clicking canvas acquires pointer lock if available for borderless 360° steering
    if (canvas.requestPointerLock && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  };

  const onPointerMove = (e) => {
    const isLocked = (document.pointerLockElement === canvas);
    if (!isOrbitDragging && !isLocked) return;

    const dx = isLocked ? e.movementX : (e.movementX ?? (e.clientX - lastPointerX));
    const dy = isLocked ? e.movementY : (e.movementY ?? (e.clientY - lastPointerY));
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;

    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
      applyMouseLook(dx, dy);
    }
  };

  const endDrag = () => {
    if (isOrbitDragging) {
      isOrbitDragging = false;
      canvas.classList.remove('dragging');
    }
  };

  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // Two-finger touchpad horizontal/vertical swipe
  window.addEventListener('wheel', (e) => {
    if (splash && !splash.classList.contains('hidden')) return;
    if (e.target?.closest?.('#controls-panel')) return;
    e.preventDefault();

    let dx = e.deltaX || 0;
    let dy = e.deltaY || 0;
    if (e.deltaMode === 1) { // LINE mode
      dx *= 22;
      dy *= 22;
    } else if (e.deltaMode === 2) { // PAGE mode
      dx *= 100;
      dy *= 100;
    }
    applyMouseLook(dx * 0.85, dy * 0.85);
  }, { passive: false });

  // Double-click canvas quickly re-centers pitch to level horizon
  canvas.addEventListener('dblclick', () => {
    if (physics) physics.aimPitch = 0;
    camPitchOffset = 0;
  });

  // Clicking OSD camera button cycles camera view
  if (osdCam) {
    osdCam.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleCameraView();
    });
  }
}

// ============================================================
// Launch
// ============================================================
function launch() {
  splash.classList.add('hidden');
  osd.classList.remove('hidden');
  controlsPanel.classList.remove('hidden');

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'r' || e.key === 'R')) {
      physics.reset();
      resetCamera();
      rings.reset();
      finishBanner.classList.add('hidden');
    }
    if (e.key === 'c' || e.key === 'C' || e.key === 'v' || e.key === 'V') {
      cycleCameraView();
    }
    if (e.key === '[' || e.key === '{') {
      fpvTiltDeg = Math.max(0, fpvTiltDeg - 5);
    }
    if (e.key === ']' || e.key === '}') {
      fpvTiltDeg = Math.min(60, fpvTiltDeg + 5);
    }
  });

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    postfx.setSize(w, h);
    camera3p.aspect = w / h;
    cameraFPV.aspect = w / h;
    camera3p.updateProjectionMatrix();
    cameraFPV.updateProjectionMatrix();
  });

  running = true;
  prevTime = performance.now();
  requestAnimationFrame(loop);
}

// ============================================================
// Game loop
// ============================================================
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - prevTime) / 1000, 0.05);
  prevTime = now;
  if (!running) return;

  // ── Input Priority: Keyboard (base) → ESP32 (tilt override) → Gamepad (full override) ──

  // 1) Keyboard — always the base layer; sets pitchInput/rollInput/yawInput/verticalInput
  input.update(dt);

  // 2) ESP32 Motion Controller — replaces tilt axes when actively tilted,
  //    adds button climb to vertical on top of keyboard (clamped).
  if (esp32) {
    const esp = esp32.read();
    if (esp && esp.active) {
      // Replace pitch axis with ESP32 tilt if the ESP32 is actually tilted
      // (threshold > 0.02 prevents zero-tilt state from locking out keyboard W/S)
      if (Math.abs(esp.pitch) > 0.02) {
        physics.pitchInput = Math.max(-1, Math.min(1, esp.pitch));
      }
      // Replace roll axis if ESP32 is actually rolled
      if (Math.abs(esp.roll) > 0.02) {
        physics.rollInput = Math.max(-1, Math.min(1, esp.roll));
      }
      // Replace yaw axis if ESP32 provides yaw (only when YAW_ENABLED=1 in firmware)
      if (Math.abs(esp.yaw) > 0.02) {
        physics.yawInput = Math.max(-1, Math.min(1, esp.yaw));
      }
      // Tactile Buttons UP/DOWN: supplement keyboard vertical input (additive, clamped)
      // This lets you use keyboard ArrowUp AND button at the same time safely.
      if (esp.up || esp.down) {
        const btnDir = (esp.up ? 1 : 0) - (esp.down ? 1 : 0);
        physics.verticalInput = Math.max(-1, Math.min(1, physics.verticalInput + btnDir));
      }
    }
  }

  // 3) Gamepad — only overrides when sticks are actively moved (|value| > deadzone)
  //    Prevents gamepad at rest from zeroing out ESP32/keyboard inputs.
  const padState = gamepad.read();
  if (padState) {
    const dz = physics.inputDeadzone;
    const padPitch    = physics.applyDeadzone(padState.pitch);
    const padRoll     = physics.applyDeadzone(padState.roll);
    const padYaw      = physics.applyDeadzone(padState.yaw);
    const padVertical = physics.applyDeadzone(padState.vertical);
    // Only override an axis if the gamepad stick is actually pushed
    if (Math.abs(padState.pitch)    > dz) physics.pitchInput    = padPitch;
    if (Math.abs(padState.roll)     > dz) physics.rollInput     = padRoll;
    if (Math.abs(padState.yaw)      > dz) physics.yawInput      = padYaw;
    if (Math.abs(padState.vertical) > dz) physics.verticalInput = padVertical;
  }

  physics.update(dt);
  if (world) world.update(physics.position);
  syncDroneMesh();
  spinProps(dt);
  updateCameras(dt);

  // Ring course progress
  const event = rings.update(physics.position, now);
  if (event?.type === 'finished') {
    finishTime.textContent = formatMs(event.ms);
    finishBanner.classList.remove('hidden');
  }
  updateOSD(now);

  postfx.render();
}

function syncDroneMesh() {
  const p = physics.position;
  const r = physics.rotation;
  droneGroup.position.set(p.x, p.y, p.z);
  droneGroup.rotation.order = 'YXZ';
  droneGroup.rotation.set(r.x, r.y, r.z);
}

function spinProps(dt) {
  const thr = physics.throttleInput;
  const speed = (6 + thr * 55) * dt;
  if (droneProps) {
    droneProps.forEach((p) => { p.rotation[p._spinAxis] += p._spinDir * speed; });
  }
  if (propGlow) propGlow.intensity = thr * 1.5;
}

function shortestAngleDiff(target, current) {
  let diff = (target - current) % (2 * Math.PI);
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  return diff;
}

function updateCameras(dt) {
  const p = physics.position;
  const r = physics.rotation;
  const aimPitch = physics.aimPitch || 0;

  if (isFPV) {
    // Real FPV racing drone camera mounted on front nose with uptilt (default 25°, adjustable)
    const fpvTiltRad = (fpvTiltDeg * Math.PI) / 180;
    const noseOffset = new THREE.Vector3(0, 0.10, -0.26).applyEuler(
      new THREE.Euler(r.x, r.y, r.z, 'YXZ')
    );
    cameraFPV.position.set(p.x + noseOffset.x, p.y + noseOffset.y, p.z + noseOffset.z);

    const droneEuler = new THREE.Euler(r.x, r.y, r.z, 'YXZ');
    const droneQuat = new THREE.Quaternion().setFromEuler(droneEuler);
    const camTiltQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      fpvTiltRad
    );
    cameraFPV.quaternion.copy(droneQuat).multiply(camTiltQuat);
  } else {
    // --- 3rd Person Dynamic Chase / Close Camera ---
    const isClose = (cameraView === CameraView.Close);
    const speed = physics.speed;

    const targetDist = isClose
      ? 2.2 + Math.min(speed * 0.03, 0.7)
      : 6.0 + Math.min(speed * 0.05, 2.0);
    const targetHeight = isClose ? 0.72 : 2.2;
    const lookAheadDist = isClose ? 1.4 : 3.6;

    // 1) Smooth orbital yaw tracking: smoothly sweeps behind the drone
    const yawDiff = shortestAngleDiff(r.y, chaseYaw);
    const yawLerp = 1 - Math.pow(0.0005, dt * 8.0);
    chaseYaw += yawDiff * yawLerp;
    chaseYaw = ((chaseYaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    chaseDist += (targetDist - chaseDist) * (1 - Math.pow(0.01, dt * 4.0));
    chaseHeight += (targetHeight - chaseHeight) * (1 - Math.pow(0.01, dt * 4.5));

    // Spherical camera placement behind drone based on chaseYaw and camPitchOffset
    // When aimPitch > 0 (aiming up), camPitchOffset is negative, camera is lower behind looking up
    // When aimPitch < 0 (aiming down), camPitchOffset is positive, camera is higher behind looking down
    const cosPitch = Math.cos(camPitchOffset);
    const sinPitch = Math.sin(camPitchOffset);
    const horizDist = chaseDist * Math.max(0.12, cosPitch);
    const vertDist  = chaseHeight + chaseDist * sinPitch;

    const camX = p.x + Math.sin(chaseYaw) * horizDist;
    const camZ = p.z + Math.cos(chaseYaw) * horizDist;
    let camY   = p.y + vertDist;

    // Keep camera above terrain
    const minY = terrainHeight(camX, camZ) + (isClose ? 0.35 : 0.6);
    if (camY < minY) camY = minY;
    camera3p.position.set(camX, camY, camZ);

    // 2) Look-Ahead in true 3D space: camera targets point along 3D forward line of sight!
    const cosP = Math.cos(aimPitch);
    const sinP = Math.sin(aimPitch);
    const fwdX = -Math.sin(r.y) * cosP;
    const fwdY = sinP;
    const fwdZ = -Math.cos(r.y) * cosP;

    const rightX = Math.cos(r.y);
    const rightZ = -Math.sin(r.y);
    const turnLead = physics.angularVel.y * (isClose ? 0.15 : 0.30);
    const velLead  = isClose ? 0.05 : 0.10;

    const desiredTarget = new THREE.Vector3(
      p.x + fwdX * lookAheadDist + rightX * turnLead + physics.velocity.x * velLead,
      p.y + (isClose ? 0.20 : 0.35) + fwdY * lookAheadDist + (physics.velocity.y * 0.06),
      p.z + fwdZ * lookAheadDist + rightZ * turnLead + physics.velocity.z * velLead
    );
    camTarget.lerp(desiredTarget, 1 - Math.pow(0.005, dt * 8.0));
    camera3p.lookAt(camTarget);

    // 3) Dynamic Banking / Roll Angle: camera tilts into the turn like a real drone game
    const targetBank = (r.z * 0.35 - physics.angularVel.y * 0.08);
    chaseBank += (targetBank - chaseBank) * (1 - Math.pow(0.001, dt * 6.0));
    camera3p.rotateZ(chaseBank);

    // 4) Dynamic FOV based on flight speed & turn rate
    const baseFov = isClose ? 65 : 60;
    const speedRatio = Math.min(1, speed / 30);
    const targetFov = baseFov + speedRatio * 8 + Math.min(5, Math.abs(physics.angularVel.y) * 2.0);
    camera3p.fov += (targetFov - camera3p.fov) * (1 - Math.pow(0.01, dt * 4.0));
    camera3p.updateProjectionMatrix();
  }
}

function updateOSD(now) {
  const mode = physics.currentMode;
  osd.className = '';
  if (mode === FlightMode.Acro)    osd.classList.add('mode-acro');
  if (mode === FlightMode.Angle)   osd.classList.add('mode-angle');
  if (mode === FlightMode.Horizon) osd.classList.add('mode-horizon');

  osdMode.textContent = `MODE: ${mode.toUpperCase()}`;
  osdThr.textContent  = `THR: ${(physics.throttleInput * 100).toFixed(0)}%`;
  osdAlt.textContent  = `ALT: ${Math.max(0, physics.altitude).toFixed(1)} m`;
  osdSpd.textContent  = `SPD: ${physics.speed.toFixed(1)} m/s`;

  if (cameraView === CameraView.Chase) {
    osdCam.textContent = '3RD PERSON (CHASE)';
  } else if (cameraView === CameraView.Close) {
    osdCam.textContent = '3RD PERSON (CLOSE)';
  } else {
    osdCam.textContent = `FPV CAM (${fpvTiltDeg}°)`;
  }
  osdRings.textContent = `RINGS: ${rings.passed}/${rings.total}`;
  osdTime.textContent = formatMs(rings.elapsedMs(now));
  osdBest.textContent = rings.bestMs !== null ? `BEST ${formatMs(rings.bestMs)}` : '';
  if (esp32 && esp32.connected) {
    const pPct = (esp32.state.pitch * 100).toFixed(0);
    const rPct = (esp32.state.roll * 100).toFixed(0);
    const vertStr = esp32.state.up ? '▲' : (esp32.state.down ? '▼' : '·');
    const tLabel  = esp32.transport === 'ws' ? '📶' : '🔌';
    osdPad.textContent = `${tLabel} ESP32 [${vertStr}] P:${pPct}% R:${rPct}%`;
    osdPad.classList.remove('hidden');
  } else if (gamepad?.driving) {
    osdPad.textContent = 'GAMEPAD';
    osdPad.classList.remove('hidden');
  } else {
    osdPad.textContent = '';
    osdPad.classList.add('hidden');
  }

  if (thrFill) {
    const pct = (physics.throttleInput * 100).toFixed(0);
    thrFill.style.height = pct + '%';
    const pctLabel = document.getElementById('thr-pct');
    if (pctLabel) pctLabel.textContent = pct + '%';
  }
}

function formatMs(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

// ============================================================
// Boot
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadAll();
  } catch (err) {
    loadingText.textContent = 'Failed to load: ' + err.message;
    console.error(err);
    return;
  }
  launchBtn.addEventListener('click', launch);
  // ?autostart skips the splash (used for smoke tests / quick relaunches)
  if (new URLSearchParams(location.search).has('autostart')) launch();
});

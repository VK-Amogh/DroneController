// scene-builder.js
// Builds the world: HDRI sky + IBL, INFINITE chunked PBR terrain that
// follows the drone, per-chunk vegetation/rocks, landing pad at origin.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const CHUNK = 140;   // meters per terrain chunk
const GRID = 7;      // 7x7 chunks = 980m detailed chunked terrain around drone
const TREES_PER_CHUNK = 8;
const ROCKS_PER_CHUNK = 3;

export async function buildScene(renderer, onProgress = () => {}) {
  const scene = new THREE.Scene();
  // Clear atmospheric haze: vast visibility across kilometers of infinite terrain, dissolves outer rim
  scene.fog = new THREE.FogExp2(0xb4cce0, 0.00092);

  let done = 0;
  const total = 5;
  const tick = () => onProgress(++done / total);

  // ---- HDRI sky + image-based lighting ----
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const hdr = await new HDRLoader().loadAsync('/env/sky.hdr');
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  scene.environment = envMap;
  scene.background = envMap;
  scene.backgroundIntensity = 1.0;
  hdr.dispose();
  pmrem.dispose();
  tick();

  // ---- Lighting (follows drone infinitely) ----
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.position.set(160, 220, 100);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -220;
  sun.shadow.camera.right = 220;
  sun.shadow.camera.top = 220;
  sun.shadow.camera.bottom = -220;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x5a6b4a, 0.40);
  scene.add(hemi);
  tick();

  // ---- Textures ----
  const texLoader = new THREE.TextureLoader();
  const [groundDiff, groundNor, groundRough] = await Promise.all([
    texLoader.loadAsync('/tex/ground_diff.jpg'),
    texLoader.loadAsync('/tex/ground_nor.jpg'),
    texLoader.loadAsync('/tex/ground_rough.jpg'),
  ]);
  tick();
  [groundDiff, groundNor, groundRough].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8, 8); // per-chunk tiling
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  });
  groundDiff.colorSpace = THREE.SRGBColorSpace;

  const [rockDiff, rockNor] = await Promise.all([
    texLoader.loadAsync('/tex/rock_diff.jpg'),
    texLoader.loadAsync('/tex/rock_nor.jpg'),
  ]);
  rockDiff.colorSpace = THREE.SRGBColorSpace;
  [rockDiff, rockNor].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
  });
  tick();

  // ---- Infinite chunked world ----
  const world = new World(scene, sun, {
    ground: { diff: groundDiff, nor: groundNor, rough: groundRough },
    rock: { diff: rockDiff, nor: rockNor },
  });
  world.update({ x: 0, z: 0 }, true); // initial fill around spawn
  tick();

  // ---- Landing pad (origin only) ----
  _buildPad(scene);

  return { scene, terrainHeight, world };
}

// Shared height function — deterministic everywhere, so physics,
// terrain chunks and vegetation always agree on the ground level across the infinite world.
export function terrainHeight(x, z) {
  // Flat zone around the landing pad at origin (~18m)
  const flatR = 18;
  const d = Math.hypot(x, z);

  // 1) Continental mountain ridges and wide valley basins (peaks up to 45m)
  const mountains =
    Math.sin(x * 0.0032) * Math.cos(z * 0.0035) * 32.0 +
    Math.cos(x * 0.0062 + 1.2) * Math.sin(z * 0.0058) * 18.0;

  // 2) Rolling hills, ridges, and slopes
  const hills =
    Math.sin(x * 0.015 + 0.8) * Math.cos(z * 0.018 + 1.1) * 9.0 +
    Math.cos(x * 0.035 + 2.1) * Math.sin(z * 0.032 + 0.5) * 4.5;

  // 3) Fine ground undulations and natural ripples
  const detail =
    Math.sin(x * 0.08 + 3.1) * Math.cos(z * 0.075 + 2.4) * 1.8 +
    Math.sin(x * 0.18) * Math.sin(z * 0.16) * 0.6;

  const total = mountains + hills + detail;

  // Seamless smoothstep transition around spawn pad
  const t = THREE.MathUtils.smoothstep(d, flatR, flatR * 3.5);
  return total * t;
}

// Deterministic PRNG so each chunk always grows the same vegetation
function _hashRand(cx, cz) {
  let h = (cx * 374761393 + cz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  let seed = (h ^ (h >>> 16)) >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

class World {
  constructor(scene, sun, tex) {
    this.scene = scene;
    this.sun = sun;
    this.chunks = [];
    this.centerCX = null;
    this.centerCZ = null;

    const groundMat = new THREE.MeshStandardMaterial({
      map: tex.ground.diff,
      normalMap: tex.ground.nor,
      roughnessMap: tex.ground.rough,
      roughness: 1.0,
      metalness: 0.0,
      color: 0x9db87e, // tint toward grass
    });
    const rockMat = new THREE.MeshStandardMaterial({
      map: tex.rock.diff,
      normalMap: tex.rock.nor,
      roughness: 0.95,
    });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.9 });
    const leafMats = [
      new THREE.MeshStandardMaterial({ color: 0x2c5220, roughness: 0.85 }),
      new THREE.MeshStandardMaterial({ color: 0x3a6b28, roughness: 0.85 }),
    ];

    // Shared chunk geometries (36x36 grid per chunk for smooth hills)
    this._groundGeo = new THREE.PlaneGeometry(CHUNK, CHUNK, 36, 36);
    this._trunkGeo = new THREE.CylinderGeometry(0.14, 0.26, 1, 7);
    this._coneGeo = new THREE.ConeGeometry(1, 2.2, 8);
    this._rockGeo = new THREE.IcosahedronGeometry(1, 1);

    this._mats = { groundMat, rockMat, trunkMat, leafMats };

    // High-density chunked terrain (49 chunks, 980m wide)
    for (let i = 0; i < GRID * GRID; i++) {
      this.chunks.push(this._makeChunk());
    }

    // Distant Horizon Skirt: seamless circular terrain ring extending out to 3.6 kilometers!
    // Guarantees zero borders, zero black void, and no end to the world anywhere!
    this._skirtGeo = new THREE.RingGeometry(440, 3600, 64, 16);
    this._skirt = new THREE.Mesh(this._skirtGeo, groundMat);
    this._skirt.rotation.x = -Math.PI / 2;
    this._skirt.receiveShadow = false;
    this.scene.add(this._skirt);

    this._clouds = _makeClouds(scene);
  }

  _makeChunk() {
    const group = new THREE.Group();
    this.scene.add(group);

    const ground = new THREE.Mesh(this._groundGeo.clone(), this._mats.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    // Pre-create vegetation; repositioned deterministically on every remap
    const trees = [];
    for (let i = 0; i < TREES_PER_CHUNK; i++) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(this._trunkGeo, this._mats.trunkMat);
      trunk.castShadow = true;
      tree.add(trunk);
      const cones = [];
      for (let t = 0; t < 3; t++) {
        const cone = new THREE.Mesh(this._coneGeo, this._mats.leafMats[t % 2]);
        cone.castShadow = true;
        cones.push(cone);
        tree.add(cone);
      }
      group.add(tree);
      trees.push({ tree, trunk, cones });
    }

    const rocks = [];
    for (let i = 0; i < ROCKS_PER_CHUNK; i++) {
      const rock = new THREE.Mesh(this._rockGeo, this._mats.rockMat);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
      rocks.push(rock);
    }

    return { group, ground, trees, rocks, cx: null, cz: null };
  }

  _remapChunk(chunk, cx, cz) {
    chunk.cx = cx;
    chunk.cz = cz;
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    chunk.group.position.set(ox, 0, oz);

    // Terrain heights (plane local +y maps to world -z after rotation)
    const pos = chunk.ground.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = ox + pos.getX(i);
      const wz = oz - pos.getY(i);
      pos.setZ(i, terrainHeight(wx, wz));
    }
    pos.needsUpdate = true;
    chunk.ground.geometry.computeVertexNormals();

    // Vegetation via deterministic RNG
    const rand = _hashRand(cx, cz);

    chunk.trees.forEach(({ tree, trunk, cones }) => {
      const lx = (rand() - 0.5) * (CHUNK - 8);
      const lz = (rand() - 0.5) * (CHUNK - 8);
      const wx = ox + lx;
      const wz = oz + lz;
      const base = terrainHeight(wx, wz);
      const h = 2.5 + rand() * 4.5;

      tree.position.set(lx, base, lz);
      trunk.scale.set(1, h, 1);
      trunk.position.y = h / 2;
      const tiers = 2 + Math.floor(rand() * 2);
      cones.forEach((cone, t) => {
        cone.visible = t < tiers;
        const r = 1.7 - t * 0.35;
        cone.scale.set(r, 1, r);
        cone.position.y = h + t * 1.35 + 0.5;
      });
      tree.rotation.y = rand() * Math.PI * 2;
    });

    chunk.rocks.forEach((rock) => {
      const lx = (rand() - 0.5) * (CHUNK - 8);
      const lz = (rand() - 0.5) * (CHUNK - 8);
      const s = 0.6 + rand() * 2.6;
      rock.scale.set(s, s * 0.7, s);
      rock.position.set(lx, terrainHeight(ox + lx, oz + lz) + s * 0.15, lz);
      rock.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
    });
  }

  _remapSkirt(dronePos) {
    if (!this._skirt) return;
    this._skirt.position.set(dronePos.x, 0, dronePos.z);
    const pos = this._skirtGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const ly = pos.getY(i);
      const wx = dronePos.x + lx;
      const wz = dronePos.z - ly;
      pos.setZ(i, terrainHeight(wx, wz));
    }
    pos.needsUpdate = true;
    this._skirtGeo.computeVertexNormals();
  }

  update(dronePos, force = false) {
    const cx = Math.round(dronePos.x / CHUNK);
    const cz = Math.round(dronePos.z / CHUNK);

    if (force || cx !== this.centerCX || cz !== this.centerCZ) {
      this.centerCX = cx;
      this.centerCZ = cz;

      // Desired chunk coords in a GRID×GRID block around the drone
      const half = (GRID - 1) / 2;
      const wanted = new Set();
      for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) {
          wanted.add(`${cx + dx},${cz + dz}`);
        }
      }

      // Free up chunks that fell out of range, remap them to missing cells
      const free = this.chunks.filter((c) => !wanted.has(`${c.cx},${c.cz}`));
      const have = new Set(
        this.chunks.filter((c) => wanted.has(`${c.cx},${c.cz}`))
          .map((c) => `${c.cx},${c.cz}`),
      );
      let fi = 0;
      for (const key of wanted) {
        if (have.has(key)) continue;
        const [ncx, ncz] = key.split(',').map(Number);
        this._remapChunk(free[fi++], ncx, ncz);
      }

      // Re-align the distant 3.6km horizon skirt so ground never ends
      this._remapSkirt(dronePos);
    }

    // Clouds wrap around the drone so the sky is always populated
    for (const cloud of this._clouds) {
      const span = 2000;
      let dx = cloud.position.x - dronePos.x;
      let dz = cloud.position.z - dronePos.z;
      dx = ((dx % span) + span * 1.5) % span - span / 2;
      dz = ((dz % span) + span * 1.5) % span - span / 2;
      cloud.position.x = dronePos.x + dx;
      cloud.position.z = dronePos.z + dz;
    }

    // Sun + shadow camera follow the drone everywhere in the infinite world
    this.sun.position.set(dronePos.x + 160, 220, dronePos.z + 100);
    this.sun.target.position.set(dronePos.x, 0, dronePos.z);
    this.sun.target.updateMatrixWorld();
  }
}

function _buildPad(scene) {
  const padMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.85, metalness: 0.1 });
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.4, 0.18, 40), padMat);
  pad.position.y = 0.09;
  pad.receiveShadow = true;
  scene.add(pad);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(4.6, 5.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xffa500, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.19;
  scene.add(ring);

  const hBar = new THREE.MeshBasicMaterial({ color: 0xf5f5f5 });
  const mkBar = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), hBar);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.19, z);
    scene.add(m);
  };
  mkBar(0.7, 3.4, -1.05, 0);
  mkBar(0.7, 3.4, 1.05, 0);
  mkBar(2.1, 0.7, 0, 0);
}

function _makeClouds(scene) {
  const clouds = [];
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  for (let i = 0; i < 38; i++) {
    const g = new THREE.Group();
    const puffs = 4 + Math.floor(Math.random() * 4);
    for (let j = 0; j < puffs; j++) {
      const r = 6 + Math.random() * 8;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
      m.position.set(
        (Math.random() - 0.5) * r * 2.2,
        (Math.random() - 0.5) * r * 0.5,
        (Math.random() - 0.5) * r * 1.6,
      );
      g.add(m);
    }
    g.position.set(
      (Math.random() - 0.5) * 2000,
      100 + Math.random() * 90,
      (Math.random() - 0.5) * 2000,
    );
    scene.add(g);
    clouds.push(g);
  }
  return clouds;
}

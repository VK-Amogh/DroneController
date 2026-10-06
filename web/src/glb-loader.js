// glb-loader.js
// Loads the real drone GLB model, normalizes its scale, detects propellers.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DRONE_URL = '/models/drone.glb';
const TARGET_SIZE = 0.62; // meters, largest dimension of the quad frame

export function loadDroneModel(onProgress) {
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      DRONE_URL,
      (gltf) => resolve(_prepareDrone(gltf.scene)),
      (evt) => {
        if (onProgress && evt.total > 0) onProgress(evt.loaded / evt.total);
      },
      (err) => reject(err),
    );
  });
}

function _prepareDrone(root) {
  const group = new THREE.Group();
  group.add(root);

  // -- Normalize scale so the quad is TARGET_SIZE across, centered at origin,
  //    resting on y=0 (its lowest point touches the ground plane).
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = TARGET_SIZE / maxDim;
  root.scale.setScalar(scale);

  // Re-measure after scaling, then center.
  const box2 = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  root.position.sub(center);
  root.position.y -= box2.min.y - center.y; // lift so min y sits at 0
  root.position.y += TARGET_SIZE * 0.18;    // body center rides a bit above origin

  // -- Shadows + material polish
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (m && 'metalness' in m) { m.metalness = Math.min(m.metalness ?? 0, 0.35); }
        if (m && 'roughness' in m) { m.roughness = Math.max(m.roughness ?? 1, 0.45); }
      });
    }
  });

  // -- Detect propellers: nodes named fan.001 … fan.004
  const props = [];
  root.traverse((obj) => {
    if (obj.isMesh && /^fan\.\d+$/i.test(obj.name)) props.push(obj);
  });
  props.sort((a, b) => a.name.localeCompare(b.name));

  // Spin each prop around its own thinnest local axis (the disc normal).
  props.forEach((prop, i) => {
    prop.geometry.computeBoundingBox();
    const bb = prop.geometry.boundingBox;
    const ext = new THREE.Vector3();
    bb.getSize(ext);
    const axis = ext.x <= ext.y && ext.x <= ext.z ? 'x'
               : ext.y <= ext.z ? 'y' : 'z';
    prop._spinAxis = axis;
    prop._spinDir = (i % 2 === 0) ? 1 : -1; // counter-rotating pairs
  });

  // -- Prop wash glow light underneath
  const propGlow = new THREE.PointLight(0x88aaff, 0, 3);
  propGlow.position.set(0, -0.25, 0);
  group.add(propGlow);

  return { group, props, propGlow };
}

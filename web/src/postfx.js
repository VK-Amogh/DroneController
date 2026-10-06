// postfx.js
// Post-processing: bloom + vignette-style polish via EffectComposer.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createPostFX(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.28,   // strength — subtle, just for emissive rings/LEDs and sky highlights
    0.6,    // radius
    0.85,   // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    composer,
    setCamera(cam) {
      composer.passes[0].camera = cam;
    },
    setSize(w, h) {
      composer.setSize(w, h);
    },
    render() {
      composer.render();
    },
  };
}

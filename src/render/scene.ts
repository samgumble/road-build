import * as THREE from 'three';
import { PIXEL_RATIO_CAP, SHADOW_MAP_SIZE } from './quality';
import { buildHorizonSkirt } from './horizonSkirt';

export interface SceneRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  onResize: (fn: () => void) => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneRig {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#bcd9e8');
  scene.fog = new THREE.Fog('#bcd9e8', 400, 900);
  scene.add(buildHorizonSkirt());

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 2, 2000);
  camera.position.set(340, 260, 340);
  camera.lookAt(0, 0, 0);

  const hemi = new THREE.HemisphereLight('#cfe8ff', '#3d3a30', 0.65);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff3d6', 2.0);
  sun.position.set(160, 220, 90);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // Shadow frustum fitted to the island (±280, slightly inside the ±256 world half-extent's
  // useful play area but generous enough that edge builds still cast/receive correctly).
  sun.shadow.camera.left = -280;
  sun.shadow.camera.right = 280;
  sun.shadow.camera.top = 280;
  sun.shadow.camera.bottom = -280;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 700;
  // Bias tuned to avoid acne on flat ground (too-small bias) and peter-panning at vehicle/building
  // bases (too-large bias). normalBias offsets along the surface normal, which handles grazing-angle
  // shadow acne on the terrain better than depth bias alone at this shadow-map resolution.
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.4;
  scene.add(sun);
  scene.add(sun.target);

  const resizeCallbacks: Array<() => void> = [];
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.setSize(window.innerWidth, window.innerHeight);
    for (const fn of resizeCallbacks) fn();
  });

  return {
    renderer,
    scene,
    camera,
    sun,
    hemi,
    onResize: (fn) => resizeCallbacks.push(fn),
  };
}

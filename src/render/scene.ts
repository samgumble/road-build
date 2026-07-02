import * as THREE from 'three';

export interface SceneRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

export function createScene(canvas: HTMLCanvasElement): SceneRig {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#bcd9e8');
  scene.fog = new THREE.Fog('#bcd9e8', 400, 900);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(340, 260, 340);
  camera.lookAt(0, 0, 0);

  const hemi = new THREE.HemisphereLight('#cfe8ff', '#3d3a30', 0.65);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff3d6', 2.0);
  sun.position.set(160, 220, 90);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -300;
  sun.shadow.camera.right = 300;
  sun.shadow.camera.top = 300;
  sun.shadow.camera.bottom = -300;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, sun, hemi };
}

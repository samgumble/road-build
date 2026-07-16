import * as THREE from 'three';
import { QUALITY } from './quality';

// Large enough that the camera's maximum 620-unit orbit cannot approach the shell. The former
// 900-unit dome exposed its coarse latitude bands when zoomed out and panned off-centre.
const DOME_RADIUS = 2400;

const STAR_COUNT_HIGH = 1400;
const STAR_COUNT_LOW = 500;
const STAR_FADE_START = -0.02; // sun elevation where stars begin fading in
const STAR_FADE_END = -0.15; // fully visible by this elevation

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform float uSunVisibility; // 0..1, fades the disc/glow out at night
  varying vec3 vWorldDir;

  void main() {
    vec3 dir = normalize(vWorldDir);
    float h = clamp(dir.y, -1.0, 1.0);
    // Gradient: horizon color at the equator, easing to zenith color overhead.
    float t = smoothstep(-0.1, 0.75, h);
    vec3 col = mix(uHorizon, uZenith, t);

    // Sun disc + soft glow. Skip the term entirely when the sun isn't visible (elevation below
    // horizon) rather than relying on uSunVisibility=0 to zero it out — pow(sunDot, 220.0) with a
    // near-1 sunDot at grazing angles could still contribute a visible sliver before multiplying.
    if (uSunVisibility > 0.001) {
      float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
      float disc = smoothstep(0.9994, 0.9998, sunDot);
      float glow = pow(sunDot, 220.0) * 0.6 + pow(sunDot, 16.0) * 0.15;
      col += (disc * 1.4 + glow) * uSunVisibility * vec3(1.0, 0.96, 0.85);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

const STAR_VERTEX_SHADER = /* glsl */ `
  uniform float uOpacity;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize;
    vAlpha = uOpacity;
  }
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a <= 0.001) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, a);
  }
`;

/**
 * Inverted-sphere sky dome consuming atmosphere's per-frame colors/sun direction. Replaces
 * `scene.background` (atmosphere still computes fog color from the same horizon color, so fog and
 * dome always agree at the skyline). Stars fade in as a Points layer once sun elevation drops
 * below STAR_FADE_START.
 */
export class Sky {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private starMaterial: THREE.ShaderMaterial;
  private zenithScratch = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(DOME_RADIUS, 96, 64);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uHorizon: { value: new THREE.Color('#bcd9e8') },
        uZenith: { value: new THREE.Color('#5f8fc9') },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunVisibility: { value: 1 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const starCount = QUALITY === 'high' ? STAR_COUNT_HIGH : STAR_COUNT_LOW;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      // Uniform points on a sphere (upper-biased — stars mostly overhead/upper sky).
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(1 - v * 1.4); // bias toward upper hemisphere
      const r = DOME_RADIUS * 0.98;
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.cos(phi);
      const z = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3] = x;
      positions[i * 3 + 1] = Math.abs(y);
      positions[i * 3 + 2] = z;
      sizes[i] = 1 + Math.random() * 1.8;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.starMaterial = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX_SHADER,
      fragmentShader: STAR_FRAGMENT_SHADER,
      uniforms: { uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMaterial);
    this.stars.renderOrder = -999;
    this.stars.frustumCulled = false;
    scene.add(this.stars);
  }

  /**
   * Drive dome uniforms from atmosphere's current per-frame state. `horizon` is the same color
   * atmosphere applies to scene.fog, so the dome's base blends seamlessly into the fog at the
   * skyline. `zenith` is derived here (darkened/cooled variant) rather than a second keyframe
   * table, so there's exactly one source of truth for "what color is the sky right now."
   */
  update(horizon: THREE.Color, sunDirection: THREE.Vector3, sunElevation: number): void {
    this.material.uniforms.uHorizon.value.copy(horizon);

    // Zenith: darker and slightly cooler/bluer than horizon, scaled down further at night so the
    // overhead sky reads near-black rather than a flat dark blue dome.
    this.zenithScratch.copy(horizon).multiplyScalar(0.55);
    this.zenithScratch.r *= 0.85;
    this.zenithScratch.g *= 0.95;
    this.zenithScratch.b = Math.min(1, this.zenithScratch.b * 1.15);
    this.material.uniforms.uZenith.value.copy(this.zenithScratch);

    this.material.uniforms.uSunDir.value.copy(sunDirection);
    // Sun disc/glow only visible when actually above the horizon (elevation > 0); fades out fast
    // once it dips below so it doesn't show through the ground.
    const visibility = THREE.MathUtils.clamp((sunElevation + 0.03) / 0.15, 0, 1);
    this.material.uniforms.uSunVisibility.value = visibility;

    const starT = THREE.MathUtils.clamp(
      (STAR_FADE_START - sunElevation) / (STAR_FADE_START - STAR_FADE_END),
      0,
      1,
    );
    this.starMaterial.uniforms.uOpacity.value = starT;
  }
}

import * as THREE from 'three';
import { GRID_SIZE, WORLD_SIZE, WATER_LEVEL, CELL } from '../core/constants';
import type { Heightfield } from '../sim/terrain/heightfield';
import type { EventBus } from '../core/events';
import { QUALITY } from './quality';

const SAND = new THREE.Color('#c9b98a');
const GRASS = new THREE.Color('#7fae6b');
const ROCK = new THREE.Color('#8d8577');

const SAND_MAX_Y = 1;
const GRASS_MAX_Y = 14;
const ROCK_SLOPE = 0.6;

const NORMAL_RECOMPUTE_THROTTLE_MS = 100;

// Terrain "seasoning": a cheap, low-frequency value-noise hash multiplying vertex color by
// roughly ±6%, breaking up the flat low-poly color bands without adding any texture lookups.
// Injected once via onBeforeCompile so it costs nothing extra to author/maintain vs. a full
// custom ShaderMaterial, and keeps MeshStandardMaterial's PBR lighting untouched.
const TERRAIN_SEASONING_GLSL = /* glsl */ `
  // Cheap 2D value-noise hash (world-xz based), no textures.
  float groundworkHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float groundworkValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = groundworkHash(i);
    float b = groundworkHash(i + vec2(1.0, 0.0));
    float c = groundworkHash(i + vec2(0.0, 1.0));
    float d = groundworkHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`;

const WATER_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uRippleAmp;
  uniform float uRippleSpeed;
  attribute float aShore; // 0 at shoreline, 1 far offshore (deep water)
  attribute float aEdgeFade; // 1 = fully visible, 0 = faded to transparent (far past any shore)
  varying float vShore;
  varying float vEdgeFade;
  varying vec2 vWorldXZ;
  varying float vFogDepth;

  void main() {
    vShore = aShore;
    vEdgeFade = aEdgeFade;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;

    // Gentle normal-perturbation ripple: displace Y a tiny amount with two drifting sine fields.
    // Amplitude drops toward shore so foam band stays a clean, flat band rather than rippling too.
    // uRippleAmp/uRippleSpeed are lower on the low tier (cheaper-looking, slower motion — spec'd
    // as "simplified" rather than removed, since the shader cost itself is the same either way).
    float rippleAmp = uRippleAmp * smoothstep(0.0, 0.25, aShore);
    float t = uTime * uRippleSpeed;
    float wave = sin(worldPos.x * 0.18 + t * 1.3) * 0.5 + sin(worldPos.z * 0.23 - t * 1.7) * 0.5;
    vec3 displaced = position;
    displaced.y += wave * rippleAmp;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform float uOpacity;
  uniform float uFoamAnimAmount; // 0 on low tier (static band), 1 on high (animated)
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying float vShore;
  varying float vEdgeFade;
  varying vec2 vWorldXZ;
  varying float vFogDepth;

  float waterHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float waterNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = waterHash(i);
    float b = waterHash(i + vec2(1.0, 0.0));
    float c = waterHash(i + vec2(0.0, 1.0));
    float d = waterHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Depth tint: deeper (higher vShore) = darker/more saturated blue.
    vec3 col = mix(uShallowColor, uDeepColor, smoothstep(0.0, 1.0, vShore));

    // Shore foam: a soft band right at the shoreline, animated on high tier, static on low tier
    // (uFoamAnimAmount gates the time-varying terms without branching).
    float animatedShore = vShore + (waterNoise(vWorldXZ * 0.08 + uTime * 0.05 * uFoamAnimAmount) - 0.5) * 0.05;
    float foam = 1.0 - smoothstep(0.0, 0.09, animatedShore);
    float sparkle = waterNoise(vWorldXZ * 0.6 + uTime * 0.4 * uFoamAnimAmount);
    foam *= 0.75 + 0.25 * sparkle;
    col = mix(col, vec3(0.95, 0.98, 1.0), foam);

    float alpha = mix(uOpacity, min(1.0, uOpacity + foam * 0.3), foam);

    // Fog: blend toward the scene fog color with camera distance, same linear falloff THREE's
    // built-in materials use. Without this, the water plane's far edge (well past the terrain
    // silhouette from a top-down camera) rendered as a hard-edged flat-colored polygon against the
    // sky dome — a regression from the original MeshStandardMaterial, which got fog for free.
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    col = mix(col, fogColor, fogFactor);

    // Edge fade: reaches fully TRANSPARENT (alpha=0, not just fog-colored) well past any real
    // shoreline, using vEdgeFade (baked per-vertex from heightfield DEPTH, not raw XZ radius — see
    // writeShoreAttribute). A plain radial fade doesn't follow the island's actual irregular
    // coastline shape, so a fixed-radius cutoff either clips water still visibly inside the true
    // shoreline in some directions, or leaves a ring of water poking above the terrain silhouette
    // against the sky dome's gradient in others — this shipped as a visible gray-wash bug once
    // already this task (see task report before/after screenshots) before switching to depth-based
    // fading, which follows the coastline correctly in every direction.
    alpha *= vEdgeFade;

    gl_FragColor = vec4(col, alpha);
  }
`;

const WATER_SEGMENTS = QUALITY === 'high' ? 128 : 48; // low tier: cheaper ripple mesh
const WATER_SHORE_DEPTH = 16; // world units of "shore falloff" — aShore reaches 1 this far past WATER_LEVEL
const WATER_RIPPLE_AMP = QUALITY === 'high' ? 0.05 : 0.03;
const WATER_RIPPLE_SPEED = QUALITY === 'high' ? 1.0 : 0.5;
const WATER_FOAM_ANIM = QUALITY === 'high' ? 1.0 : 0.0;

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly water: THREE.Mesh;
  private geo: THREE.PlaneGeometry;
  private waterMaterial: THREE.ShaderMaterial;
  private waterTime = 0;

  private lastNormalRecomputeAt = 0;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty: { minI: number; minJ: number; maxI: number; maxJ: number } | null = null;

  constructor(scene: THREE.Scene, private hf: Heightfield, bus: EventBus) {
    this.geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID_SIZE - 1, GRID_SIZE - 1);
    this.geo.rotateX(-Math.PI / 2);

    const colorArray = new Float32Array(GRID_SIZE * GRID_SIZE * 3);
    this.geo.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    this.writeHeightsAndColors(0, 0, GRID_SIZE - 1, GRID_SIZE - 1);
    this.geo.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true });
    // Task 28 terrain seasoning: multiply the final vertex color by a low-frequency world-xz value
    // noise, ±6%. Injected via onBeforeCompile rather than a bespoke ShaderMaterial so we keep
    // MeshStandardMaterial's lighting/shadow model untouched — this is seasoning, not a rewrite.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSeasonScale = { value: 1 / 42 }; // world units per noise cell (large-scale)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vGroundworkWorldXZ;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvGroundworkWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform float uSeasonScale;\nvarying vec2 vGroundworkWorldXZ;\n${TERRAIN_SEASONING_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\nfloat groundworkSeason = groundworkValueNoise(vGroundworkWorldXZ * uSeasonScale);\ndiffuseColor.rgb *= 0.94 + groundworkSeason * 0.12;`,
        );
    };
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Extent generous enough that the depth-based edge fade (see writeShoreAttribute/aEdgeFade)
    // always completes to full transparency well inside the mesh's own boundary — the fade follows
    // the heightfield's true depth-from-shore, so as long as the plane is comfortably larger than
    // "island radius + EDGE_FADE_END", there's no hard mesh-edge cutoff visible from any angle.
    const waterExtent = WORLD_SIZE * 1.3;
    const waterGeo = new THREE.PlaneGeometry(waterExtent, waterExtent, WATER_SEGMENTS, WATER_SEGMENTS);
    waterGeo.rotateX(-Math.PI / 2);
    this.writeShoreAttribute(waterGeo);

    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uShallowColor: { value: new THREE.Color('#5fa3c4') },
          uDeepColor: { value: new THREE.Color('#245577') },
          uOpacity: { value: 0.82 },
          uRippleAmp: { value: WATER_RIPPLE_AMP },
          uRippleSpeed: { value: WATER_RIPPLE_SPEED },
          uFoamAnimAmount: { value: WATER_FOAM_ANIM },
        },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.water = new THREE.Mesh(waterGeo, this.waterMaterial);
    // sit a hair below WATER_LEVEL so shoreline triangles crossing y=0 don't z-fight
    this.water.position.y = WATER_LEVEL - 0.06;
    this.water.renderOrder = 1;
    this.water.receiveShadow = true;
    scene.add(this.water);

    bus.on('terrain:deformed', ({ minI, minJ, maxI, maxJ }) => this.refreshRegion(minI, minJ, maxI, maxJ));
  }

  /**
   * Per-vertex distance-to-shore approximation, baked once at build time from the heightfield:
   * 0 right at the shoreline (terrain height ~= WATER_LEVEL), ramping to 1 by WATER_SHORE_DEPTH
   * world units of "how far below WATER_LEVEL the underlying terrain sits" (a proxy for actual
   * depth, since we don't simulate real underwater bathymetry). Vertices beyond the terrain's own
   * footprint are treated as full depth, with `aEdgeFade` (see below) taking over from there.
   */
  private writeShoreAttribute(waterGeo: THREE.PlaneGeometry): void {
    const posAttr = waterGeo.attributes.position;
    const shoreArr = new Float32Array(posAttr.count);
    const edgeFadeArr = new Float32Array(posAttr.count);
    const terrainHalf = WORLD_SIZE / 2;
    // Task 28 finding: a plain radial (distance-from-origin) fade for the water plane's outer edge
    // doesn't line up with the island's actual (irregular, fbm-shaped) coastline — a fixed-radius
    // threshold either cuts water off while still visibly inside the true shoreline in some
    // directions, or leaves a visible ring of water still poking above the terrain silhouette
    // against the sky dome's gradient in others (this shipped as a bug once already this task; see
    // task report). Basing the edge fade on `depthBelowWater` instead (the same per-vertex quantity
    // already sampled from the heightfield for `aShore`) follows the coastline's true shape in
    // every direction, because water gets progressively deeper the further it is from ANY shore
    // point, not just distance from world origin.
    const EDGE_FADE_START = 30; // depth (world units) where the outer fade begins
    const EDGE_FADE_END = 46; // depth where alpha reaches exactly 0
    for (let idx = 0; idx < posAttr.count; idx++) {
      const x = posAttr.getX(idx);
      const z = posAttr.getZ(idx);
      let shore: number;
      let depthBelowWater: number;
      if (Math.abs(x) > terrainHalf || Math.abs(z) > terrainHalf) {
        shore = 1; // off the terrain grid entirely — treat as open/deep water
        // Heightfield has no data out here; fall back to EUCLIDEAN distance past the grid's
        // inscribed circle as a depth proxy (grows the further out we go, same qualitative
        // behavior as real depth). Using max(|x|,|z|) here instead (Chebyshev/square distance)
        // made the fade complete at a different true distance near the plane's corners than its
        // sides, leaving a faint diamond-shaped seam visible in the far distance — this shipped as
        // a (subtler, second) version of the edge-artifact bug this task hit — see task report.
        depthBelowWater = Math.hypot(x, z) - terrainHalf + WATER_SHORE_DEPTH;
      } else {
        const groundY = this.hf.heightAt(x, z);
        depthBelowWater = WATER_LEVEL - groundY; // positive underwater, negative on land
        shore = THREE.MathUtils.clamp(depthBelowWater / WATER_SHORE_DEPTH, 0, 1);
      }
      const edgeFadeT = THREE.MathUtils.clamp(
        (depthBelowWater - EDGE_FADE_START) / (EDGE_FADE_END - EDGE_FADE_START),
        0,
        1,
      );
      edgeFadeArr[idx] = 1 - edgeFadeT; // 1 = fully visible, 0 = faded to transparent
      shoreArr[idx] = shore;
    }
    waterGeo.setAttribute('aShore', new THREE.BufferAttribute(shoreArr, 1));
    waterGeo.setAttribute('aEdgeFade', new THREE.BufferAttribute(edgeFadeArr, 1));
  }

  /** Advances the water ripple/foam time uniform. Called every render frame from main.ts. */
  update(dt: number): void {
    this.waterTime += dt;
    this.waterMaterial.uniforms.uTime.value = this.waterTime;
  }

  private colorForVertex(i: number, j: number, y: number): THREE.Color {
    const half = WORLD_SIZE / 2;
    const slope = this.hf.slopeAt(i * CELL - half, j * CELL - half);
    if (slope > ROCK_SLOPE) return ROCK;
    if (y < SAND_MAX_Y) return SAND;
    if (y < GRASS_MAX_Y) return GRASS;
    return ROCK;
  }

  private writeHeightsAndColors(minI: number, minJ: number, maxI: number, maxJ: number): void {
    const posAttr = this.geo.attributes.position;
    const colorAttr = this.geo.attributes.color;
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const idx = j * GRID_SIZE + i;
        const y = this.hf.heights[idx];
        posAttr.setY(idx, y);
        const c = this.colorForVertex(i, j, y);
        colorAttr.setXYZ(idx, c.r, c.g, c.b);
      }
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  refreshRegion(minI: number, minJ: number, maxI: number, maxJ: number): void {
    this.writeHeightsAndColors(minI, minJ, maxI, maxJ);

    if (this.dirty) {
      this.dirty.minI = Math.min(this.dirty.minI, minI);
      this.dirty.minJ = Math.min(this.dirty.minJ, minJ);
      this.dirty.maxI = Math.max(this.dirty.maxI, maxI);
      this.dirty.maxJ = Math.max(this.dirty.maxJ, maxJ);
    } else {
      this.dirty = { minI, minJ, maxI, maxJ };
    }

    const now = performance.now();
    const elapsed = now - this.lastNormalRecomputeAt;
    if (elapsed >= NORMAL_RECOMPUTE_THROTTLE_MS) {
      this.flushNormals();
    } else if (this.pendingFlushTimer === null) {
      this.pendingFlushTimer = setTimeout(() => this.flushNormals(), NORMAL_RECOMPUTE_THROTTLE_MS - elapsed);
    }
  }

  private flushNormals(): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = null;
    this.geo.computeVertexNormals();
    this.lastNormalRecomputeAt = performance.now();
  }
}

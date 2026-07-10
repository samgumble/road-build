import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EventBus } from '../core/events';
import { DAY_LENGTH, WORLD_SIZE } from '../core/constants';
import { clamp01 } from './easing';
import { Sky } from './sky';
import { solarTimeOfDay, sunElevation } from './solarTime';

/** A single keyframe stop, at a given point in the 0..1 day cycle. */
interface Stop {
  t: number;
  color: THREE.Color;
}

// Sky/fog color stops across the day cycle (matches the brief's palette).
// Task 23: user reported night reading as too dark ("moonless pit"). Lifted the two deep-night
// stops from '#0e1220' to '#151b30' — a touch more blue and noticeably higher luminance (roughly
// +40% per channel) — while leaving dusk/dawn stops untouched, so the mood shifts from "pitch
// black" to "clear night with ambient skyglow" without flattening the day/night contrast.
const SKY_STOPS: Stop[] = [
  { t: 0.0, color: new THREE.Color('#151b30') }, // deep night
  { t: 0.10, color: new THREE.Color('#151b30') }, // still night just before the shorter dawn
  { t: 1 / 6, color: new THREE.Color('#f5a35c') }, // sunrise
  { t: 0.25, color: new THREE.Color('#bfd9e8') }, // full day
  { t: 0.75, color: new THREE.Color('#bfd9e8') }, // full day
  { t: 5 / 6, color: new THREE.Color('#e07a3f') }, // sunset
  { t: 0.90, color: new THREE.Color('#151b30') }, // short night
  { t: 1.0, color: new THREE.Color('#151b30') },
];

const SUN_WARM = new THREE.Color('#fff3d6');

function sampleStops(stops: Stop[], t: number): THREE.Color {
  const wrapped = ((t % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (wrapped >= a.t && wrapped <= b.t) {
      const span = b.t - a.t;
      const localT = span > 0 ? (wrapped - a.t) / span : 0;
      return a.color.clone().lerp(b.color, clamp01(localT));
    }
  }
  return stops[stops.length - 1].color.clone();
}

const CLOUD_GROUP_COUNT = 9;
const CLOUD_DRIFT_SPEED = 1.5; // u/s, +x
const CLOUD_Y_MIN = 60;
const CLOUD_Y_MAX = 80;

interface CloudGroup {
  mesh: THREE.Mesh;
}

const RAIN_COUNT = 1500;
const RAIN_RADIUS = 80;
const RAIN_FALL_SPEED = 60; // u/s
const RAIN_HEIGHT = 60; // spawn ceiling above ground, recycle when reaching ground
const RAIN_STREAK_LEN = 3.4; // was rendered as disconnected point sprites (see below), barely
// visible at typical camera distance; each drop stores a head+tail position pair so it can be
// drawn as an actual line segment (a visible streak) rather than two separate dots.
const RAIN_OPACITY = 0.85; // was 0.6 — streaks read thin against daylight sky/fog otherwise
const RAIN_TRANSITION = 5; // seconds to ease rain-linked effects in/out

const RAIN_MIN_INTERVAL = 90;
const RAIN_MAX_INTERVAL = 240;
const RAIN_CHANCE = 0.4;
const RAIN_MIN_DURATION = 30;
const RAIN_MAX_DURATION = 60;

const NIGHT_HYSTERESIS = 0.02;

// Task 38: eased 0..1 daylight signal for anything downstream (water shader) that needs to scale
// its own brightness with the day/night cycle. Reuses the exact same sun-elevation easing curve
// already driving hemi intensity (`elevation01` in applyTimeOfDay) rather than introducing a
// second keyframe/easing system — DAYLIGHT_NIGHT_FLOOR mirrors the "clear night, not a moonless
// pit" floor established in Task 23 (see SKY_STOPS/hemi comments) so water stays barely readable
// rather than going fully black.
const DAYLIGHT_NIGHT_FLOOR = 0.25;

const EXPOSURE_DAY = 1.0;
// Task 23: raised from 0.65 so ACES tone mapping doesn't crush night scenes to near-black;
// 0.75 keeps a clear day/night exposure difference while making terrain silhouettes readable.
const EXPOSURE_NIGHT = 0.75;
const EXPOSURE_LAMBDA = 1.5; // ease rate, 1/s

/**
 * Owns day/night cycling (sky, fog, sun/hemi light, renderer exposure), drifting cloud groups, and
 * a scheduled rain system. `update(dt)` is driven from the render callback (visual pacing only —
 * not part of the fixed-step sim); the caller (main.ts) is responsible for multiplying its
 * wall-clock `dt` by `Loop.timeScale` before passing it in, so the day cycle speeds up along with
 * the HUD's 1x/4x/16x control the same way the fixed-step sim does.
 */
export class Atmosphere {
  timeOfDay = 0.35;

  private clouds: CloudGroup[] = [];

  private rainLines: THREE.LineSegments;
  private rainVelocities: Float32Array;
  private rainActive = false;
  private rainIntensity = 0; // eased 0..1, drives sun/fog coupling
  private rainTimer: number; // seconds until next scheduler roll
  private rainRemaining = 0; // seconds left in current shower (0 when not raining)

  private wasNight: boolean;
  private baseFogNear: number;
  private baseFogFar: number;
  private sky: Sky;
  private sunDirScratch = new THREE.Vector3();
  private daylightValue = 1;

  constructor(
    private scene: THREE.Scene,
    private sun: THREE.DirectionalLight,
    private hemi: THREE.HemisphereLight,
    private renderer: THREE.WebGLRenderer,
    private bus: EventBus,
    private rng: () => number,
  ) {
    const fog = this.scene.fog as THREE.Fog;
    this.baseFogNear = fog.near;
    this.baseFogFar = fog.far;

    this.wasNight = sunElevation(this.timeOfDay) < -NIGHT_HYSTERESIS;

    this.sky = new Sky(this.scene);
    // The dome fully replaces scene.background visually (it's drawn behind everything at the far
    // plane), but we keep scene.background set too — it's what THREE uses as the fallback/clear
    // color and what fog math implicitly assumes matches the horizon, so leaving it in sync costs
    // nothing and avoids any edge-case flash before the dome's first frame.
    this.buildClouds();

    const rainGeom = new THREE.BufferGeometry();
    // Each drop is a head+tail vertex pair forming one line segment (a visible streak); rendering
    // this layout as THREE.Points (as before) draws the head and tail as two separate disconnected
    // dots and never actually connects them, which is why rain read as faint dust rather than
    // streaks at typical camera distance. THREE.LineSegments draws the segment itself.
    const positions = new Float32Array(RAIN_COUNT * 3 * 2);
    this.rainVelocities = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.spawnRainDrop(positions, i);
      this.rainVelocities[i] = RAIN_FALL_SPEED * (0.85 + 0.3 * this.rng());
    }
    rainGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: '#dcecf7',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.rainLines = new THREE.LineSegments(rainGeom, rainMat);
    this.rainLines.frustumCulled = false;
    this.scene.add(this.rainLines);

    this.rainTimer = RAIN_MIN_INTERVAL + this.rng() * (RAIN_MAX_INTERVAL - RAIN_MIN_INTERVAL);

    // Apply initial state immediately so frame 0 isn't default-lit.
    this.applyTimeOfDay();
  }

  get night(): boolean {
    return this.wasNight;
  }

  /** Eased 0..1 daylight signal: 1.0 at midday, floors at DAYLIGHT_NIGHT_FLOOR (~0.25) in deep
   * night. Derived from the same sun-elevation easing as hemi intensity — see applyTimeOfDay. */
  get daylight(): number {
    return this.daylightValue;
  }

  /** Eased presentation-only rain amount used by road materials and other visual consumers. */
  get rainAmount(): number {
    return this.rainIntensity;
  }

  private buildClouds(): void {
    for (let i = 0; i < CLOUD_GROUP_COUNT; i++) {
      const puffCount = 3 + Math.floor(this.rng() * 3); // 3-5
      const geoms: THREE.BufferGeometry[] = [];
      for (let p = 0; p < puffCount; p++) {
        const geo = new THREE.IcosahedronGeometry(3 + this.rng() * 2.5, 0);
        geo.scale(1.6 + this.rng() * 0.8, 0.7 + this.rng() * 0.3, 1.2 + this.rng() * 0.6);
        const ox = (this.rng() - 0.5) * 8;
        const oy = (this.rng() - 0.5) * 2;
        const oz = (this.rng() - 0.5) * 6;
        geo.translate(ox, oy, oz);
        geoms.push(geo);
      }
      const merged = mergeGeometries(geoms, false) ?? geoms[0];
      const mat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.85,
        flatShading: true,
        roughness: 1,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.position.set(
        (this.rng() - 0.5) * WORLD_SIZE * 1.4,
        CLOUD_Y_MIN + this.rng() * (CLOUD_Y_MAX - CLOUD_Y_MIN),
        (this.rng() - 0.5) * WORLD_SIZE * 1.4,
      );
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.clouds.push({ mesh });
    }
  }

  private spawnRainDrop(positions: Float32Array, i: number): void {
    const angle = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * RAIN_RADIUS;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const y = this.rng() * RAIN_HEIGHT;
    const base = i * 6;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = z;
  }

  /** Advance the day cycle, clouds, and rain scheduler; apply all eased visuals. */
  update(dt: number): void {
    this.timeOfDay += dt / DAY_LENGTH;
    if (this.timeOfDay >= 1) this.timeOfDay -= Math.floor(this.timeOfDay);

    this.updateNightEvent();
    this.updateClouds(dt);
    this.updateRainScheduler(dt);
    this.updateRainPositions(dt);
    this.applyTimeOfDay();
    this.applyExposure(dt);
  }

  private updateNightEvent(): void {
    const elevation = sunElevation(this.timeOfDay);
    if (this.wasNight && elevation > NIGHT_HYSTERESIS) {
      this.wasNight = false;
      this.bus.emit('atmosphere:phase', { night: false });
    } else if (!this.wasNight && elevation < -NIGHT_HYSTERESIS) {
      this.wasNight = true;
      this.bus.emit('atmosphere:phase', { night: true });
    }
  }

  private updateClouds(dt: number): void {
    const halfWorld = (WORLD_SIZE * 1.4) / 2;
    for (const cloud of this.clouds) {
      cloud.mesh.position.x += CLOUD_DRIFT_SPEED * dt;
      if (cloud.mesh.position.x > halfWorld) {
        cloud.mesh.position.x = -halfWorld;
      }
    }
  }

  private updateRainScheduler(dt: number): void {
    if (this.rainRemaining > 0) {
      this.rainRemaining -= dt;
      if (this.rainRemaining <= 0) {
        this.rainRemaining = 0;
        this.rainActive = false;
        this.rainTimer = RAIN_MIN_INTERVAL + this.rng() * (RAIN_MAX_INTERVAL - RAIN_MIN_INTERVAL);
      }
      return;
    }

    this.rainTimer -= dt;
    if (this.rainTimer <= 0) {
      if (this.rng() < RAIN_CHANCE) {
        this.rainActive = true;
        this.rainRemaining = RAIN_MIN_DURATION + this.rng() * (RAIN_MAX_DURATION - RAIN_MIN_DURATION);
      } else {
        this.rainTimer = RAIN_MIN_INTERVAL + this.rng() * (RAIN_MAX_INTERVAL - RAIN_MIN_INTERVAL);
      }
    }
  }

  private updateRainPositions(dt: number): void {
    // Ease rain intensity in/out over RAIN_TRANSITION seconds regardless of scheduler granularity.
    const target = this.rainActive ? 1 : 0;
    const rate = dt / RAIN_TRANSITION;
    if (this.rainIntensity < target) this.rainIntensity = Math.min(target, this.rainIntensity + rate);
    else if (this.rainIntensity > target) this.rainIntensity = Math.max(target, this.rainIntensity - rate);

    const mat = this.rainLines.material as THREE.LineBasicMaterial;
    mat.opacity = RAIN_OPACITY * this.rainIntensity;
    this.rainLines.visible = this.rainIntensity > 0.001;

    if (!this.rainLines.visible) return;

    // Rain follows the camera target's XZ so it stays around the player without simulating world-scale weather.
    const center = this.cameraTarget;
    this.rainLines.position.set(center.x, 0, center.z);

    const positions = this.rainLines.geometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;
    for (let i = 0; i < RAIN_COUNT; i++) {
      const base = i * 6;
      let y = arr[base + 1] - this.rainVelocities[i] * dt;
      if (y <= 0) {
        // recycle to a fresh column near the top
        const angle = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * RAIN_RADIUS;
        arr[base] = Math.cos(angle) * r;
        arr[base + 2] = Math.sin(angle) * r;
        y = RAIN_HEIGHT;
      }
      arr[base + 1] = y;
      arr[base + 3] = arr[base];
      arr[base + 4] = y - RAIN_STREAK_LEN;
      arr[base + 5] = arr[base + 2];
    }
    positions.needsUpdate = true;
  }

  /** Camera target injected lazily via `setCameraTarget`; defaults to origin until wired. */
  private cameraTarget = new THREE.Vector3(0, 0, 0);
  setCameraTarget(target: THREE.Vector3): void {
    this.cameraTarget = target;
  }

  private applyTimeOfDay(): void {
    const elevationRaw = sunElevation(this.timeOfDay);
    const elevation01 = clamp01((elevationRaw + 1) / 2); // 0 at nadir, 1 at zenith

    const skyColor = sampleStops(SKY_STOPS, this.timeOfDay);

    // Densify fog 1.5x during rain, eased.
    const fogNear = THREE.MathUtils.lerp(this.baseFogNear, this.baseFogNear / 1.5, this.rainIntensity);
    const fogFar = THREE.MathUtils.lerp(this.baseFogFar, this.baseFogFar / 1.5, this.rainIntensity);

    this.scene.background = skyColor;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(skyColor);
    fog.near = fogNear;
    fog.far = fogFar;

    // Sun intensity 0 (night) -> 1.6 (noon warm), scaled by elevation, halved during rain.
    const sunIntensity = Math.max(0, elevationRaw) * 1.6 * (1 - 0.5 * this.rainIntensity);
    this.sun.intensity = sunIntensity;
    this.sun.color.copy(SUN_WARM);

    // Sun orbit: elevation drives height, azimuth drifts slowly across the day.
    const azimuth = solarTimeOfDay(this.timeOfDay) * Math.PI * 2;
    const radius = 260;
    this.sun.position.set(
      Math.cos(azimuth) * radius,
      Math.max(20, elevationRaw * radius),
      Math.sin(azimuth) * radius,
    );
    this.sun.target.position.set(0, 0, 0);

    // Hemisphere light 0.24 (night) -> 0.55 (day). Task 23: floor raised from 0.15 so the darkest
    // part of the night still has enough ambient skyglow to read terrain silhouettes, without
    // raising the daytime end (keeps day/night contrast, i.e. the "mood", intact).
    this.hemi.intensity = THREE.MathUtils.lerp(0.24, 0.55, elevation01);

    // Task 38: eased daylight signal for the water shader, same elevation01 curve as hemi above.
    // At elevation01=1 (midday) this is exactly 1.0, a no-op vs. pre-Task-38 water rendering.
    this.daylightValue = THREE.MathUtils.lerp(DAYLIGHT_NIGHT_FLOOR, 1.0, elevation01);

    // Sky dome consumes the same horizon color driving fog/background, plus the sun's true
    // (unclamped-y) direction for its disc/glow — using the un-clamped elevationRaw for the disc's
    // own height keeps the sun visually setting below the horizon rather than parking at y=20.
    this.sunDirScratch.set(
      Math.cos(azimuth) * radius,
      elevationRaw * radius,
      Math.sin(azimuth) * radius,
    );
    this.sky.update(skyColor, this.sunDirScratch, elevationRaw);
  }

  private applyExposure(dt: number): void {
    const target = this.night ? EXPOSURE_NIGHT : EXPOSURE_DAY;
    const cur = this.renderer.toneMappingExposure;
    this.renderer.toneMappingExposure = cur + (target - cur) * clamp01(EXPOSURE_LAMBDA * dt);
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EventBus } from '../core/events';
import { DAY_LENGTH, WORLD_SIZE } from '../core/constants';
import { clamp01 } from './easing';
import { Sky } from './sky';
import {
  ambientFillForElevation,
  environmentFillForElevation,
  exposureForElevation,
  solarTimeOfDay,
  sunElevation,
} from './solarTime';
import type { WeatherSaveState, WeatherSnapshot } from '../core/weather';
import { WeatherController } from './weather';
import {
  weatherCloudWeight,
  weatherAtmosphereValues,
  weatherRainVertexCount,
  type WeatherAtmosphereValues,
} from './weatherTuning';

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
const HEMI_SKY_DAY = new THREE.Color('#cfe8ff');
const HEMI_SKY_NIGHT = new THREE.Color('#6f83ad');
const HEMI_GROUND_DAY = new THREE.Color('#3d3a30');
const HEMI_GROUND_NIGHT = new THREE.Color('#1d2940');
const CLOUD_STORM = new THREE.Color('#6f7780');

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
const NIGHT_HYSTERESIS = 0.02;

// Task 38: eased 0..1 daylight signal for anything downstream (water shader) that needs to scale
// its own brightness with the day/night cycle. Reuses the exact same sun-elevation easing curve
// already driving hemi intensity (`elevation01` in applyTimeOfDay) rather than introducing a
// second keyframe/easing system — DAYLIGHT_NIGHT_FLOOR mirrors the "clear night, not a moonless
// pit" floor established in Task 23 (see SKY_STOPS/hemi comments) so water stays barely readable
// rather than going fully black.
const DAYLIGHT_NIGHT_FLOOR = 0.25;

const EXPOSURE_LAMBDA = 1.5; // ease rate, 1/s

/**
 * Owns day/night cycling (sky, fog, sun/hemi light, renderer exposure), drifting cloud groups, and
 * blended seeded weather. `update(dt)` is driven from the render callback (visual pacing only —
 * not part of the fixed-step sim); the caller (main.ts) is responsible for multiplying its
 * wall-clock `dt` by `atmosphereTimeScale(Loop.timeScale)` before passing it in, so the day cycle
 * speeds up with the HUD's 1x/4x control but stays calm (capped) at 16x.
 */
export class Atmosphere {
  timeOfDay = 0.35;

  private clouds: CloudGroup[] = [];

  private rainLines: THREE.LineSegments;
  private rainVelocities: Float32Array;

  private wasNight: boolean;
  private baseFogNear: number;
  private baseFogFar: number;
  private sky: Sky;
  private sunDirScratch = new THREE.Vector3();
  private cloudColorScratch = new THREE.Color();
  private daylightValue = 1;
  private readonly weatherValues: WeatherAtmosphereValues = {
    fogNear: 0,
    fogFar: 0,
    sunScale: 1,
    hemiScale: 1,
    cloudOpacity: 0,
    rainOpacity: 0,
  };

  constructor(
    private scene: THREE.Scene,
    private sun: THREE.DirectionalLight,
    private hemi: THREE.HemisphereLight,
    private renderer: THREE.WebGLRenderer,
    private bus: EventBus,
    private rng: () => number,
    private weather: WeatherController,
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

    // Apply initial state immediately so frame 0 isn't default-lit.
    this.refreshWeatherValues();
    this.updateClouds(0);
    this.updateRainPositions(0);
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

  /** Blended presentation-only rain amount used by road materials and other visual consumers. */
  get rainAmount(): number {
    return this.weather.snapshot.rain;
  }

  get weatherSnapshot(): Readonly<WeatherSnapshot> {
    return this.weather.snapshot;
  }

  get weatherSave(): WeatherSaveState {
    return this.weather.saved;
  }

  /** Soft radial falloff for the cloud cards, drawn once and shared. `alphaMap` reads the GREEN
   * channel, so the gradient runs white-center -> black-edge on an opaque canvas. Returns null in
   * canvas-less test environments (the clouds then render as plain soft quads — never exercised
   * visually in tests anyway). */
  private buildCloudTexture(): THREE.CanvasTexture | null {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    gradient.addColorStop(0, 'rgb(255,255,255)');
    gradient.addColorStop(0.55, 'rgb(140,140,140)');
    gradient.addColorStop(1, 'rgb(0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }

  /** Graphics-plan Task 4 slice (claimed 2026-07-14, Claude session): the old hard flat-shaded
   * icosahedron puffs read as floating rocks. Clouds are now merged SOFT CARDS — horizontal
   * quads with a shared radial alpha falloff — one mesh/draw call per group, same rng consumption,
   * same positions/drift, still lit (Lambert) so they dim through the night like everything else. */
  private buildClouds(): void {
    const texture = this.buildCloudTexture();
    for (let i = 0; i < CLOUD_GROUP_COUNT; i++) {
      const puffCount = 3 + Math.floor(this.rng() * 3); // 3-5
      const geoms: THREE.BufferGeometry[] = [];
      for (let p = 0; p < puffCount; p++) {
        const radius = 3 + this.rng() * 2.5;
        const sx = 1.6 + this.rng() * 0.8;
        this.rng(); // (was icosahedron y-scale — consumed to keep the rng sequence identical)
        const sz = 1.2 + this.rng() * 0.6;
        const geo = new THREE.PlaneGeometry(radius * 2 * sx * 1.6, radius * 2 * sz * 1.6);
        geo.rotateX(-Math.PI / 2);
        const ox = (this.rng() - 0.5) * 8;
        const oy = (this.rng() - 0.5) * 2;
        const oz = (this.rng() - 0.5) * 6;
        geo.translate(ox, oy, oz);
        geoms.push(geo);
      }
      const merged = mergeGeometries(geoms, false) ?? geoms[0];
      const mat = new THREE.MeshLambertMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      if (texture) mat.alphaMap = texture;
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

  /** Advance the day cycle and seeded weather; apply one shared blended snapshot everywhere. */
  update(dt: number): void {
    this.timeOfDay += dt / DAY_LENGTH;
    if (this.timeOfDay >= 1) this.timeOfDay -= Math.floor(this.timeOfDay);

    if (this.weather.update(dt)) {
      this.bus.emit('atmosphere:weather', { kind: this.weather.snapshot.kind });
    }
    this.refreshWeatherValues();
    this.updateNightEvent();
    this.updateClouds(dt);
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
    const snapshot = this.weather.snapshot;
    const drift = CLOUD_DRIFT_SPEED * (0.65 + 1.1 * snapshot.wind);
    this.cloudColorScratch.set(0xffffff).lerp(CLOUD_STORM, snapshot.cloudDarkness);
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      cloud.mesh.position.x += drift * dt;
      if (cloud.mesh.position.x > halfWorld) {
        cloud.mesh.position.x = -halfWorld;
      }
      const coverageWeight = weatherCloudWeight(snapshot.cloudCover, i, CLOUD_GROUP_COUNT);
      const material = cloud.mesh.material as THREE.MeshLambertMaterial;
      material.color.copy(this.cloudColorScratch);
      material.opacity = this.weatherValues.cloudOpacity * coverageWeight;
      cloud.mesh.visible = coverageWeight > 0.001;
    }
  }

  private updateRainPositions(dt: number): void {
    const rain = this.weather.snapshot.rain;
    const activeVertices = weatherRainVertexCount(rain, RAIN_COUNT);
    const activeDrops = activeVertices / 2;
    const mat = this.rainLines.material as THREE.LineBasicMaterial;
    mat.opacity = this.weatherValues.rainOpacity;
    this.rainLines.geometry.setDrawRange(0, activeVertices);
    this.rainLines.visible = activeDrops > 0 && mat.opacity > 0.001;

    if (!this.rainLines.visible) return;

    // Rain follows the camera target's XZ so it stays around the player without simulating world-scale weather.
    const center = this.cameraTarget;
    this.rainLines.position.set(center.x, 0, center.z);

    const positions = this.rainLines.geometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;
    for (let i = 0; i < activeDrops; i++) {
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

  private refreshWeatherValues(): void {
    weatherAtmosphereValues(
      this.weather.snapshot,
      this.baseFogNear,
      this.baseFogFar,
      this.weatherValues,
    );
  }

  private applyTimeOfDay(): void {
    const elevationRaw = sunElevation(this.timeOfDay);
    const elevation01 = clamp01((elevationRaw + 1) / 2); // 0 at nadir, 1 at zenith

    const skyColor = sampleStops(SKY_STOPS, this.timeOfDay);

    this.scene.background = skyColor;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(skyColor);
    fog.near = this.weatherValues.fogNear;
    fog.far = this.weatherValues.fogFar;

    // Sun intensity 0 (night) -> 1.6 (noon warm), scaled by the blended weather snapshot.
    const sunIntensity = Math.max(0, elevationRaw) * 1.6 * this.weatherValues.sunScale;
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

    // Keep diffuse form readable through twilight, and give PBR materials a restrained neutral
    // reflection source at every hour. Both curves are continuous across the horizon.
    this.hemi.intensity = ambientFillForElevation(elevationRaw) * this.weatherValues.hemiScale;
    this.scene.environmentIntensity = environmentFillForElevation(elevationRaw);
    const hemiDaylight = clamp01((elevationRaw + 0.25) / 0.85);
    this.hemi.color.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, hemiDaylight);
    this.hemi.groundColor.lerpColors(HEMI_GROUND_NIGHT, HEMI_GROUND_DAY, hemiDaylight);

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
    const weatherDim = 0.08 * this.weather.snapshot.cloudDarkness;
    const target = exposureForElevation(sunElevation(this.timeOfDay)) - weatherDim;
    const cur = this.renderer.toneMappingExposure;
    this.renderer.toneMappingExposure = cur + (target - cur) * clamp01(EXPOSURE_LAMBDA * dt);
  }
}

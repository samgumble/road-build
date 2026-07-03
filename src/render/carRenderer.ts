import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrafficCar } from '../sim/traffic/traffic';

const CAR_CAPACITY_PER_VARIANT = 32;
const VARIANT_FILES = ['sedan.glb', 'sedan-sports.glb', 'hatchback-sports.glb', 'taxi.glb'];
const MODELS_BASE = 'models/cars/';
const TARGET_LENGTH = 4.2; // u, normalized car length (Kenney kit's longest dimension)

// Fallback box-car palette (muted tones), used only if the GLTF assets fail to load.
const FALLBACK_PALETTE = [
  0x8a8f94, 0x5c6b73, 0x9c8060, 0x6e5a4e, 0x7a3b3b, 0x455a4a, 0x3f4a5a, 0xb5ab94,
];

// Task 23: user reported headlights ("tiny emissive white quads") were too subtle to read at
// night. Enlarged + brightened the glow quads (warm white, high emissiveIntensity-equivalent via
// toneMapped:false MeshBasicMaterial so ACES doesn't crush it under the darker night exposure),
// added a red tail-light pair sharing the same InstancedMesh via per-instance vertex color (still
// within the "<=2 additional InstancedMeshes" budget alongside the new light-cone mesh below), and
// added an instanced fake "beam" cone quad per car.
const HEADLIGHT_COLOR = new THREE.Color(0xfff8e0);
const TAILLIGHT_COLOR = new THREE.Color(0xff2f1f);
const HEADLIGHT_SIZE = 0.34; // was 0.22 — small enough to previously bloom-read as a faint dot
const HEADLIGHT_Y = 0.45; // height above car origin (car origin sits on the road surface)
const HEADLIGHT_FORWARD = 2.05; // distance ahead of car center along heading
const HEADLIGHT_SIDE = 0.55; // lateral offset from center
const TAILLIGHT_SIZE = 0.24;
const TAILLIGHT_BACK = 2.05; // distance behind car center along heading
const TAILLIGHT_SIDE = 0.5;

// Light-cone "fake beam": a flat trapezoid quad projecting ahead of the car at ground level,
// additive-blended and translucent so it reads as a soft headlight pool on the road without any
// real per-car lights (which would blow the instancing/draw-call budget). Authored in local space
// with the car at the origin facing local +X (narrow edge at the car, wide edge BEAM_LENGTH
// ahead), then oriented per-instance the same way the headlight quads are.
const BEAM_LENGTH = 7; // u, "projecting ~7u ahead" per spec
const BEAM_NEAR_HALF_WIDTH = 0.5; // half-width of the near (car-side) edge
const BEAM_FAR_HALF_WIDTH = 2.4; // half-width of the far edge — spreads like a real headlight cone
const BEAM_Y = 0.03; // just above ground to avoid z-fighting with road/terrain
const BEAM_COLOR = 0xffdca0;
const BEAM_OPACITY = 0.22;

// Night amount (0..1) eases toward the boolean `night` flag over this many seconds, so headlights/
// beams/tail lights fade in and out rather than popping instantly at the day/night threshold.
const NIGHT_EASE_SECONDS = 1.5;

const dummyMatrix = new THREE.Matrix4();
const dummyPos = new THREE.Vector3();
const dummyQuat = new THREE.Quaternion();
const dummyScale = new THREE.Vector3(1, 1, 1);
const upAxis = new THREE.Vector3(0, 1, 0);
// Scratch objects for the glow quads (reused across cars/frames to avoid per-car allocation).
const glowQuat = new THREE.Quaternion();
const glowScale = new THREE.Vector3(1, 1, 1);

/** One instanced-mesh "variant" pool: either a loaded GLTF car shape or the fallback box shape. */
interface VariantMesh {
  mesh: THREE.InstancedMesh;
}

/**
 * Renders traffic cars as instanced meshes. Tries to load 4 small CC0 car models (Kenney "Car
 * Kit") via GLTFLoader, merging each model's sub-meshes (body + 4 wheels, all one material) into
 * a single geometry per variant so each variant is exactly one InstancedMesh (one draw call).
 * Cars are distributed across variants by `car.id % 4` for shape/color variety. If the assets
 * fail to load for any reason, falls back to a simple box+cabin InstancedMesh (capacity 100) with
 * per-instance `instanceColor` from a muted palette, so the game never breaks.
 *
 * A second InstancedMesh ("glows") renders emissive headlight (warm white, front) and tail light
 * (red, rear) quads for each car, distinguished per-instance via `instanceColor`; a third
 * InstancedMesh ("beams") renders an additive-blended fake light-cone projecting ahead of each
 * car. Both are shown/faded via an internally-eased night amount driven by the boolean `night`
 * passed to `update(cars, night)` (see NIGHT_EASE_SECONDS) — two additional InstancedMeshes total,
 * within budget.
 */
export class CarRenderer {
  private variants: VariantMesh[] = [];
  private usingFallback = false;
  private ready = false;

  private glows: THREE.InstancedMesh;
  private glowGeo: THREE.BufferGeometry;
  private glowMat: THREE.MeshBasicMaterial;

  private beams: THREE.InstancedMesh;
  private beamGeo: THREE.BufferGeometry;
  private beamMat: THREE.MeshBasicMaterial;

  private nightAmount = 0; // eased 0..1, see NIGHT_EASE_SECONDS

  constructor(private scene: THREE.Scene) {
    // Glows (headlights + tail lights): capacity covers 2 headlight + 2 tail instances per car
    // across the full combined capacity.
    const totalCapacity = CAR_CAPACITY_PER_VARIANT * VARIANT_FILES.length;
    this.glowGeo = new THREE.PlaneGeometry(HEADLIGHT_SIZE, HEADLIGHT_SIZE);
    this.glowMat = new THREE.MeshBasicMaterial({
      // Base color white: InstancedMesh.instanceColor multiplies in automatically (three.js
      // enables USE_INSTANCING_COLOR whenever instanceColor is non-null, no vertexColors flag
      // needed) — per-instance color below drives the actual hue (warm white vs red).
      color: 0xffffff,
      toneMapped: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.glows = new THREE.InstancedMesh(this.glowGeo, this.glowMat, totalCapacity * 4);
    this.glows.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(totalCapacity * 4 * 3),
      3,
    );
    this.glows.count = 0;
    this.glows.frustumCulled = false;
    this.scene.add(this.glows);

    // Beams: one flat trapezoid per car, authored pointing local +X (see BEAM_* consts), additive
    // and depthWrite:false so overlapping beams blend rather than z-fight.
    this.beamGeo = new THREE.BufferGeometry();
    const bp = new Float32Array([
      0, BEAM_Y, -BEAM_NEAR_HALF_WIDTH,
      0, BEAM_Y, BEAM_NEAR_HALF_WIDTH,
      BEAM_LENGTH, BEAM_Y, BEAM_FAR_HALF_WIDTH,
      BEAM_LENGTH, BEAM_Y, -BEAM_FAR_HALF_WIDTH,
    ]);
    this.beamGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    this.beamGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.beamMat = new THREE.MeshBasicMaterial({
      color: BEAM_COLOR,
      toneMapped: false,
      transparent: true,
      opacity: BEAM_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beams = new THREE.InstancedMesh(this.beamGeo, this.beamMat, totalCapacity);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.scene.add(this.beams);

    this.loadGltfVariants().catch(() => {
      this.buildFallback();
    });
  }

  private async loadGltfVariants(): Promise<void> {
    const loader = new GLTFLoader();
    const loaded: VariantMesh[] = [];

    // Minor 11: previously each variant's InstancedMesh was added to the scene immediately as it
    // finished loading, inside this loop. If a later variant then failed, `.catch()` below would
    // call `buildFallback()` — but the earlier variants' meshes were already in the scene and
    // never removed/disposed, leaving them rendered as orphans alongside the fallback car. Build
    // every variant's mesh here WITHOUT adding it to the scene; only add them all (and commit
    // `this.variants`) once every variant has resolved successfully, in `loadGltfVariants`'s
    // caller. On any failure, dispose whatever partial meshes were created here before falling
    // back — see the `.catch()` in the constructor.
    try {
      for (const file of VARIANT_FILES) {
        const url = MODELS_BASE + file;
        const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
          loader.load(url, (g) => resolve(g), undefined, (err) => reject(err));
        });

        const geometries: THREE.BufferGeometry[] = [];
        let material: THREE.Material | null = null;

        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const geo = obj.geometry.clone();
          geo.applyMatrix4(obj.matrixWorld);
          // Keep only attributes we need and that are consistent across sub-meshes.
          for (const attrName of Object.keys(geo.attributes)) {
            if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
              geo.deleteAttribute(attrName);
            }
          }
          geometries.push(geo);
          if (!material) {
            const m = obj.material as THREE.Material;
            material = Array.isArray(m) ? m[0] : m;
          }
        });

        if (!geometries.length || !material) throw new Error(`No meshes found in ${file}`);

        const merged = mergeGeometries(geometries, false);
        if (!merged) throw new Error(`Failed to merge geometry for ${file}`);
        for (const g of geometries) g.dispose();

        merged.computeBoundingBox();
        const bbox = merged.boundingBox!;
        const size = new THREE.Vector3();
        bbox.getSize(size);
        // Kenney's Car Kit models are authored with the car's length along Z and sit with their
        // wheel-bottom near local y=0; normalize uniformly by the longest horizontal axis (Z) so
        // the car's length maps to TARGET_LENGTH, then lift so the lowest point sits at y=0.
        const scale = size.z > 0.001 ? TARGET_LENGTH / size.z : 1;
        merged.scale(scale, scale, scale);
        merged.computeBoundingBox();
        const liftedBox = merged.boundingBox!;
        merged.translate(0, -liftedBox.min.y, 0);

        const mat = (material as THREE.Material).clone();
        if ('map' in mat && (mat as THREE.MeshStandardMaterial).map) {
          ((mat as THREE.MeshStandardMaterial).map as THREE.Texture).colorSpace = THREE.SRGBColorSpace;
        }

        const instMesh = new THREE.InstancedMesh(merged, mat, CAR_CAPACITY_PER_VARIANT);
        instMesh.count = 0;
        instMesh.castShadow = true;
        instMesh.receiveShadow = true;
        instMesh.frustumCulled = false;

        // Forward axis convention verified empirically against this exact Kenney Car Kit export:
        // the body mesh's Z+ extent points toward the front bumper (matches wheel node naming
        // "front"/"back" being at +Z/-Z respectively) — so local +Z is forward (see the yaw
        // computation in update(), which is keyed off `this.usingFallback`).
        loaded.push({ mesh: instMesh });
      }
    } catch (err) {
      for (const v of loaded) {
        v.mesh.geometry.dispose();
        const mat = v.mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      throw err;
    }

    for (const v of loaded) this.scene.add(v.mesh);
    this.variants = loaded;
    this.usingFallback = false;
    this.ready = true;
  }

  private buildFallback(): void {
    // box-car: body 2.4 x 0.9 x 1.3 + cabin, merged into one geometry, capacity 100.
    const body = new THREE.BoxGeometry(2.4, 0.9, 1.3);
    body.translate(0, 0.45, 0);
    const cabin = new THREE.BoxGeometry(1.1, 0.6, 1.15);
    cabin.translate(-0.2, 0.9 + 0.3, 0);
    const merged = mergeGeometries([body, cabin], false)!;
    body.dispose();
    cabin.dispose();

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.7 });
    const mesh = new THREE.InstancedMesh(merged, mat, 100);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(100 * 3), 3);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // Fallback body is authored with its length along local +X (forward), unlike the GLTF
    // variants (local +Z) — the yaw computation in update() branches on `this.usingFallback` to
    // account for the difference.
    this.variants = [{ mesh }];
    this.usingFallback = true;
    this.ready = true;
  }

  /**
   * Writes each car's transform into its variant's InstancedMesh (variant = `car.id % variants`),
   * plus (faded by an internally-eased night amount, see NIGHT_EASE_SECONDS) headlight/tail-light
   * glow quads and a light-cone beam quad per car. Cars beyond a variant's capacity are silently
   * dropped (targetPopulation is capped well below capacity). `dt` is wall-clock seconds, used
   * only to ease the night fade — matches the render loop's own dt (see main.ts).
   */
  update(cars: ReadonlyArray<TrafficCar>, night: boolean, dt: number): void {
    const target = night ? 1 : 0;
    const rate = NIGHT_EASE_SECONDS > 0 ? dt / NIGHT_EASE_SECONDS : 1;
    if (this.nightAmount < target) this.nightAmount = Math.min(target, this.nightAmount + rate);
    else if (this.nightAmount > target) this.nightAmount = Math.max(target, this.nightAmount - rate);

    if (!this.ready || this.variants.length === 0) return;

    const perVariantIndex = new Array(this.variants.length).fill(0);
    let glowIndex = 0;
    let beamIndex = 0;
    const lightsVisible = this.nightAmount > 0.001;
    const headColor = HEADLIGHT_COLOR;
    const tailColor = TAILLIGHT_COLOR;

    for (const car of cars) {
      const variantIdx = car.id % this.variants.length;
      const variant = this.variants[variantIdx];
      const slot = perVariantIndex[variantIdx]++;
      if (slot >= variant.mesh.instanceMatrix.count) continue;

      // Heading is atan2(dz, dx): 0 = facing +X. The GLTF variants' merged geometry has its
      // forward axis along local +Z, so rotate an extra -90deg (equivalently, offset the yaw)
      // to align local +Z with world heading direction. The fallback box-car's forward axis is
      // local +X already, matching heading directly.
      const yaw = this.usingFallback ? -car.heading : -car.heading + Math.PI / 2;

      dummyPos.set(car.pos.x, car.pos.y, car.pos.z);
      dummyQuat.setFromAxisAngle(upAxis, yaw);
      dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
      variant.mesh.setMatrixAt(slot, dummyMatrix);

      if (this.usingFallback && variant.mesh.instanceColor) {
        const color = FALLBACK_PALETTE[car.id % FALLBACK_PALETTE.length];
        const c = new THREE.Color(color);
        variant.mesh.setColorAt(slot, c);
      }

      if (lightsVisible) {
        const fx = Math.cos(car.heading);
        const fz = Math.sin(car.heading);
        const sx = -Math.sin(car.heading);
        const sz = Math.cos(car.heading);
        glowQuat.setFromAxisAngle(upAxis, -car.heading + Math.PI / 2);

        for (const side of [-1, 1]) {
          if (glowIndex < this.glows.instanceMatrix.count) {
            const hx = car.pos.x + fx * HEADLIGHT_FORWARD + sx * HEADLIGHT_SIDE * side;
            const hz = car.pos.z + fz * HEADLIGHT_FORWARD + sz * HEADLIGHT_SIDE * side;
            const hy = car.pos.y + HEADLIGHT_Y;
            dummyPos.set(hx, hy, hz);
            dummyMatrix.compose(dummyPos, glowQuat, dummyScale);
            this.glows.setMatrixAt(glowIndex, dummyMatrix);
            this.glows.setColorAt(glowIndex, headColor);
            glowIndex++;
          }
        }
        for (const side of [-1, 1]) {
          if (glowIndex < this.glows.instanceMatrix.count) {
            const tx = car.pos.x - fx * TAILLIGHT_BACK + sx * TAILLIGHT_SIDE * side;
            const tz = car.pos.z - fz * TAILLIGHT_BACK + sz * TAILLIGHT_SIDE * side;
            const ty = car.pos.y + HEADLIGHT_Y;
            dummyPos.set(tx, ty, tz);
            const s = TAILLIGHT_SIZE / HEADLIGHT_SIZE;
            glowScale.set(s, s, s);
            dummyMatrix.compose(dummyPos, glowQuat, glowScale);
            this.glows.setMatrixAt(glowIndex, dummyMatrix);
            this.glows.setColorAt(glowIndex, tailColor);
            glowIndex++;
          }
        }

        if (beamIndex < this.beams.instanceMatrix.count) {
          // Beam geometry's forward axis is local +X, matching the fallback box-car convention
          // (see the `yaw` computation above, which uses -car.heading for +X-forward geometry).
          dummyPos.set(car.pos.x, car.pos.y, car.pos.z);
          dummyQuat.setFromAxisAngle(upAxis, -car.heading);
          dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
          this.beams.setMatrixAt(beamIndex, dummyMatrix);
          beamIndex++;
        }
      }
    }

    for (let i = 0; i < this.variants.length; i++) {
      const v = this.variants[i];
      v.mesh.count = Math.min(perVariantIndex[i], v.mesh.instanceMatrix.count);
      v.mesh.instanceMatrix.needsUpdate = true;
      if (v.mesh.instanceColor) v.mesh.instanceColor.needsUpdate = true;
    }

    // Eased fade: opacity ramps with nightAmount (not a hard on/off), matching the 1-2s ease the
    // spec calls for; mesh stays visible through the fade and only fully hides at amount<=0.
    this.glows.visible = lightsVisible;
    this.glows.count = lightsVisible ? glowIndex : 0;
    this.glows.instanceMatrix.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
    this.glowMat.opacity = 0.95 * this.nightAmount;

    this.beams.visible = lightsVisible;
    this.beams.count = lightsVisible ? beamIndex : 0;
    this.beams.instanceMatrix.needsUpdate = true;
    this.beamMat.opacity = BEAM_OPACITY * this.nightAmount;
  }

  dispose(): void {
    for (const v of this.variants) {
      this.scene.remove(v.mesh);
      v.mesh.geometry.dispose();
      const mat = v.mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    this.scene.remove(this.glows);
    this.glowGeo.dispose();
    this.glowMat.dispose();
    this.scene.remove(this.beams);
    this.beamGeo.dispose();
    this.beamMat.dispose();
  }
}

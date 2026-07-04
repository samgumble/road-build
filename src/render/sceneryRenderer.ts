import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Heightfield } from '../sim/terrain/heightfield';
import { EventBus } from '../core/events';
import type { GrowthKind, SpawnRecord } from '../sim/growth/growth';
import type { WildernessTree } from '../sim/growth/wilderness';
import { easeOutBack, clamp01 } from './easing';

const POP_IN_DURATION = 0.8; // seconds, easeOutBack scale 0 -> 1
// Task 31: fade-out duration for wilderness trees cleared by road construction.
const WILDERNESS_FADE_DURATION = 1.5;
// u — small jitter spreading multiple trees within one wilderness site (mirrors GrowthSim's own
// JITTER constant for road-grown trees) so a 2-3 tree site doesn't read as perfectly stacked.
const WILDERNESS_TREE_JITTER = 2.2;

// Task 31: raised from 4000 to make room for several hundred wilderness sites (1-3 trees each,
// several hundred to ~1200 trees) on top of GrowthSim's own road-driven tree spawns sharing the
// same InstancedMesh pool.
const TREE_CAPACITY = 6000;
const FIELD_CAPACITY = 600;
const HOUSE_CAPACITY = 800;
const BUILDING_CAPACITY = 300;
const WINDOW_CAPACITY = HOUSE_CAPACITY + BUILDING_CAPACITY; // 1 emissive window quad per house/building

const TREE_FILES = ['nature/tree_default.glb', 'nature/tree_pineRoundC.glb', 'nature/tree_pineTallA.glb'];
const HOUSE_FILES = ['suburban/building-type-a.glb', 'suburban/building-type-c.glb'];
const BUILDING_FILES = ['commercial/building-skyscraper-e.glb'];
const MODELS_BASE = 'models/scenery/';

const TARGET_TREE_HEIGHT = 5.5; // u, normalized tree height (varies per real-world tree, ~4-8u)
const TARGET_HOUSE_HEIGHT = 3.4; // u, matches brief's ~4x3x4 house footprint
const TARGET_BUILDING_HEIGHT = 10; // u, matches brief's 5x10x5 building footprint

const FIELD_SIZE = 10;
const FIELD_STRIPE_COLORS = ['#7fae6b', '#6a9b58'];

const FLATTEN_RADIUS = 5;

const WINDOW_SIZE = 0.5;
const WINDOW_DAY_INTENSITY = 0;
const WINDOW_NIGHT_INTENSITY = 1.4;
const WINDOW_COLOR = '#ffdf8a';

const dummyMatrix = new THREE.Matrix4();
const dummyPos = new THREE.Vector3();
const dummyQuat = new THREE.Quaternion();
const dummyScale = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);

interface VariantMesh {
  mesh: THREE.InstancedMesh;
  baseHeight: number; // authored model height in local units after normalization (for y-offset if needed)
}

/** One live instance slot: which variant + index within that variant's InstancedMesh, plus the
 * spawn-time transform (used both for pop-in animation and for rebuild-without-animation). */
interface Instance {
  kind: GrowthKind;
  variant: VariantMesh;
  slot: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  windowSlot: number | null; // index into the window InstancedMesh, if this instance has windows
}

/** An instance currently animating pop-in scale 0 -> 1. */
interface Animating {
  instance: Instance;
  elapsed: number;
}

/** An instance currently fading out scale 1 -> 0 (Task 31: wilderness trees cleared by road
 * construction). Once elapsed reaches WILDERNESS_FADE_DURATION the instance is parked off-screen
 * (InstancedMesh has no per-slot removal, so "deleting" a middle slot just means hiding it). */
interface Fading {
  instance: Instance;
  elapsed: number;
}

function fallbackTreeVariant(color: number, scene: THREE.Scene, capacity: number): VariantMesh {
  const trunk = new THREE.CylinderGeometry(0.15, 0.2, 1, 6);
  trunk.translate(0, 0.5, 0);
  const canopy = new THREE.ConeGeometry(1.4, 3, 8);
  canopy.translate(0, 1 + 1.5, 0);
  const merged = mergeGeometries([trunk, canopy], false)!;
  trunk.dispose();
  canopy.dispose();
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 });
  const mesh = new THREE.InstancedMesh(merged, mat, capacity);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, baseHeight: 4 };
}

function fallbackHouseVariant(scene: THREE.Scene, capacity: number): VariantMesh {
  const body = new THREE.BoxGeometry(4, 3, 4);
  body.translate(0, 1.5, 0);
  const roof = new THREE.ConeGeometry(3.2, 1.8, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 3 + 0.9, 0);
  const merged = mergeGeometries([body, roof], false)!;
  body.dispose();
  roof.dispose();
  const mat = new THREE.MeshStandardMaterial({ color: '#d8d5cd', flatShading: true, roughness: 0.9 });
  const mesh = new THREE.InstancedMesh(merged, mat, capacity);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, baseHeight: 4.8 };
}

function fallbackBuildingVariant(scene: THREE.Scene, capacity: number): VariantMesh {
  const geo = new THREE.BoxGeometry(5, 10, 5);
  geo.translate(0, 5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: '#9a9488', flatShading: true, roughness: 0.85 });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, baseHeight: 10 };
}

/**
 * Renders development-sim scenery (`growth:spawn` events) as instanced meshes. Trees and
 * buildings/houses try to load small CC0 Kenney GLTF models (Nature Kit trees, City Kit
 * Suburban/Commercial houses+skyscraper); each variant's sub-meshes are merged into a single
 * geometry so each variant renders as exactly one InstancedMesh (one draw call), following the
 * same pattern as `carRenderer.ts`. If any model fails to load, ALL scenery falls back to simple
 * procedural primitives (cone trees, box houses, box building) so the game never breaks — the two
 * paths are mutually exclusive per category (tree/house/building) and chosen once at startup.
 *
 * Fields have no good CC0 fit and stay procedural per the brief: a flat two-tone striped quad.
 *
 * New spawns animate scale 0 -> 1 over 0.8s with easeOutBack; because these are instanced meshes,
 * only a small "animating" list of recently-spawned instances has its per-instance matrix
 * recomputed each frame (not the whole InstancedMesh), so pop-in scales to thousands of instances
 * without a per-frame full rebuild. `rebuild()` restores a saved `spawned` list with no animation
 * (used by Task 15 save/load).
 *
 * Houses and buildings flatten a terrain pad once at spawn and get a small emissive "window" quad
 * (tiny separate InstancedMesh, one quad per house/building instance) toggled by `atmosphere:phase`.
 */
export class SceneryRenderer {
  private treeVariants: VariantMesh[] = [];
  private houseVariants: VariantMesh[] = [];
  private buildingVariants: VariantMesh[] = [];
  private usingFallback = { tree: false, house: false, building: false };
  private ready = { tree: false, house: false, building: false };

  private field: THREE.InstancedMesh;
  private fieldStripe: THREE.InstancedMesh;
  private fieldCount = 0;
  private stripeCount = 0;

  private windows: THREE.InstancedMesh;
  private windowGeo: THREE.BufferGeometry;
  private windowMat: THREE.MeshStandardMaterial;
  private windowCount = 0;

  private instances: Instance[] = [];
  private animating: Animating[] = [];
  private fading: Fading[] = [];

  // spawn events that arrive before their category's variants have finished loading are queued
  // and flushed once that category becomes ready. Minor 7: `animate` is carried alongside each
  // record (not hardcoded true at flush time) so a `rebuild()`-sourced record whose category
  // wasn't ready yet still gets placed with no pop-in once its variants load — matching every
  // other already-ready category in that same restore.
  private pendingSpawns: { rec: SpawnRecord; animate: boolean }[] = [];

  // Task 31: wilderness sites queued if `setWilderness` is called before tree variants finish
  // loading (mirrors pendingSpawns above). Each site's placed instances are recorded by site
  // index so a later `wilderness:cleared` notification can find and fade exactly those instances.
  private pendingWilderness: WildernessTree[] | null = null;
  private wildernessInstancesBySite: Instance[][] = [];

  constructor(private scene: THREE.Scene, private hf: Heightfield, private bus: EventBus) {
    const fieldGeo = new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE);
    fieldGeo.rotateX(-Math.PI / 2);
    const fieldMat = new THREE.MeshStandardMaterial({ color: FIELD_STRIPE_COLORS[0], roughness: 0.95 });
    this.field = new THREE.InstancedMesh(fieldGeo, fieldMat, FIELD_CAPACITY);
    this.field.count = 0;
    this.field.receiveShadow = true;
    this.field.frustumCulled = false;
    this.scene.add(this.field);

    const stripeGeo = new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE / 5);
    stripeGeo.rotateX(-Math.PI / 2);
    stripeGeo.translate(0, 0.02, 0);
    const stripeMat = new THREE.MeshStandardMaterial({ color: FIELD_STRIPE_COLORS[1], roughness: 0.95 });
    this.fieldStripe = new THREE.InstancedMesh(stripeGeo, stripeMat, FIELD_CAPACITY * 3);
    this.fieldStripe.count = 0;
    this.fieldStripe.receiveShadow = true;
    this.fieldStripe.frustumCulled = false;
    this.scene.add(this.fieldStripe);

    this.windowGeo = new THREE.PlaneGeometry(WINDOW_SIZE, WINDOW_SIZE);
    this.windowMat = new THREE.MeshStandardMaterial({
      color: WINDOW_COLOR,
      emissive: WINDOW_COLOR,
      emissiveIntensity: WINDOW_DAY_INTENSITY,
      toneMapped: false,
    });
    this.windows = new THREE.InstancedMesh(this.windowGeo, this.windowMat, WINDOW_CAPACITY);
    this.windows.count = 0;
    this.windows.frustumCulled = false;
    this.scene.add(this.windows);

    this.bus.on('growth:spawn', (e) => this.onSpawn(e));
    this.bus.on('atmosphere:phase', ({ night }) => this.onPhase(night));
    this.bus.on('wilderness:cleared', (e) => this.onWildernessCleared(e.indices));

    this.loadGltfVariants('tree', TREE_FILES, TARGET_TREE_HEIGHT, TREE_CAPACITY, 2)
      .then((v) => {
        this.treeVariants = v;
        this.ready.tree = true;
        this.flushPending();
        this.flushPendingWilderness();
      })
      .catch(() => {
        const perVariant = Math.floor(TREE_CAPACITY / 2);
        this.treeVariants = [
          fallbackTreeVariant(0x4e7d4a, this.scene, perVariant),
          fallbackTreeVariant(0x3f6b3c, this.scene, TREE_CAPACITY - perVariant),
        ];
        this.usingFallback.tree = true;
        this.ready.tree = true;
        this.flushPending();
        this.flushPendingWilderness();
      });

    this.loadGltfVariants('house', HOUSE_FILES, TARGET_HOUSE_HEIGHT, HOUSE_CAPACITY, 1)
      .then((v) => {
        this.houseVariants = v;
        this.ready.house = true;
        this.flushPending();
      })
      .catch(() => {
        this.houseVariants = [fallbackHouseVariant(this.scene, HOUSE_CAPACITY)];
        this.usingFallback.house = true;
        this.ready.house = true;
        this.flushPending();
      });

    this.loadGltfVariants('building', BUILDING_FILES, TARGET_BUILDING_HEIGHT, BUILDING_CAPACITY, 1)
      .then((v) => {
        this.buildingVariants = v;
        this.ready.building = true;
        this.flushPending();
      })
      .catch(() => {
        this.buildingVariants = [fallbackBuildingVariant(this.scene, BUILDING_CAPACITY)];
        this.usingFallback.building = true;
        this.ready.building = true;
        this.flushPending();
      });
  }

  /** Which render path shipped per category — exposed for verification/reporting. */
  get renderPaths(): { tree: 'gltf' | 'fallback'; house: 'gltf' | 'fallback'; building: 'gltf' | 'fallback' } {
    return {
      tree: this.usingFallback.tree ? 'fallback' : 'gltf',
      house: this.usingFallback.house ? 'fallback' : 'gltf',
      building: this.usingFallback.building ? 'fallback' : 'gltf',
    };
  }

  /** Instance counts per tree variant mesh + total draw calls contributed by tree rendering
   * (one draw call per InstancedMesh) — exposed for Task 31 verification/reporting. */
  get treeStats(): { perVariant: number[]; total: number; drawCalls: number } {
    const perVariant = this.treeVariants.map((v) => v.mesh.count);
    return { perVariant, total: perVariant.reduce((a, b) => a + b, 0), drawCalls: this.treeVariants.length };
  }

  private async loadGltfVariants(
    category: 'tree' | 'house' | 'building',
    files: string[],
    targetHeight: number,
    totalCapacity: number,
    materialsPerMesh: number,
  ): Promise<VariantMesh[]> {
    const loader = new GLTFLoader();
    const loaded: VariantMesh[] = [];
    const perVariantCapacity = Math.floor(totalCapacity / files.length);

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const url = MODELS_BASE + file;
      const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
        loader.load(url, (g) => resolve(g), undefined, (err) => reject(err));
      });

      const geometries: THREE.BufferGeometry[] = [];
      let sharedMaterial: THREE.Material | null = null;
      const perPrimitiveColor: (THREE.Color | null)[] = [];

      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const geo = obj.geometry.clone();
        geo.applyMatrix4(obj.matrixWorld);
        for (const attrName of Object.keys(geo.attributes)) {
          if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
            geo.deleteAttribute(attrName);
          }
        }
        const mat = (Array.isArray(obj.material) ? obj.material[0] : obj.material) as THREE.MeshStandardMaterial;
        if (materialsPerMesh > 1) {
          // Trees: multiple flat-color (textureless) materials per mesh — bake each primitive's
          // baseColorFactor into a per-vertex color so all primitives can merge into one geometry
          // with a single `vertexColors: true` material (one draw call, no texture needed).
          perPrimitiveColor.push(mat.color ? mat.color.clone() : new THREE.Color(0xffffff));
        } else {
          perPrimitiveColor.push(null);
          if (!sharedMaterial) sharedMaterial = mat;
        }
        geometries.push(geo);
      });

      if (!geometries.length) throw new Error(`No meshes found in ${file}`);

      let merged: THREE.BufferGeometry;
      let material: THREE.Material;

      if (materialsPerMesh > 1) {
        for (let gi = 0; gi < geometries.length; gi++) {
          const geo = geometries[gi];
          const color = perPrimitiveColor[gi]!;
          const count = geo.attributes.position.count;
          const colorArr = new Float32Array(count * 3);
          for (let v = 0; v < count; v++) {
            colorArr[v * 3] = color.r;
            colorArr[v * 3 + 1] = color.g;
            colorArr[v * 3 + 2] = color.b;
          }
          geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
        }
        merged = mergeGeometries(geometries, false)!;
        material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 });
      } else {
        if (!sharedMaterial) throw new Error(`No material found in ${file}`);
        merged = mergeGeometries(geometries, false)!;
        material = (sharedMaterial as THREE.Material).clone();
        if ('map' in material && (material as THREE.MeshStandardMaterial).map) {
          ((material as THREE.MeshStandardMaterial).map as THREE.Texture).colorSpace = THREE.SRGBColorSpace;
        }
      }
      for (const g of geometries) g.dispose();

      if (!merged) throw new Error(`Failed to merge geometry for ${file}`);

      merged.computeBoundingBox();
      const bbox = merged.boundingBox!;
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const scale = size.y > 0.001 ? targetHeight / size.y : 1;
      merged.scale(scale, scale, scale);
      merged.computeBoundingBox();
      const liftedBox = merged.boundingBox!;
      merged.translate(0, -liftedBox.min.y, 0);
      merged.computeVertexNormals();

      const capacity = fi === files.length - 1 ? totalCapacity - perVariantCapacity * (files.length - 1) : perVariantCapacity;
      const mesh = new THREE.InstancedMesh(merged, material, capacity);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);

      loaded.push({ mesh, baseHeight: targetHeight });
    }

    return loaded;
  }

  private flushPending(): void {
    if (!this.pendingSpawns.length) return;
    const remaining: { rec: SpawnRecord; animate: boolean }[] = [];
    for (const entry of this.pendingSpawns) {
      if (this.categoryReady(entry.rec.kind)) this.place(entry.rec, entry.animate);
      else remaining.push(entry);
    }
    this.pendingSpawns = remaining;
  }

  private categoryReady(kind: GrowthKind): boolean {
    if (kind === 'tree') return this.ready.tree;
    if (kind === 'house') return this.ready.house;
    if (kind === 'building') return this.ready.building;
    return true; // fields are always ready (procedural, built in constructor)
  }

  private onSpawn(e: SpawnRecord): void {
    if (!this.categoryReady(e.kind)) {
      this.pendingSpawns.push({ rec: e, animate: true }); // live gameplay spawn — always pops in
      return;
    }
    this.place(e, true);
  }

  private variantIndex(x: number, z: number, count: number): number {
    const h = Math.abs(Math.imul(Math.round(x * 4) * 374761393 + Math.round(z * 4) * 668265263, 1274126177));
    return h % count;
  }

  private pickVariant(kind: GrowthKind, x: number, z: number): VariantMesh | null {
    const list = kind === 'tree' ? this.treeVariants : kind === 'house' ? this.houseVariants : this.buildingVariants;
    if (!list.length) return null;
    return list[this.variantIndex(x, z, list.length)];
  }

  /** Places one spawn record's instance(s) into the appropriate InstancedMesh(es). Returns the
   * primary placed `Instance` (Task 31: needed so `setWilderness` can track per-site instances for
   * later fade-out), or `null` if placement was skipped (over capacity / category not ready). */
  private place(rec: SpawnRecord, animate: boolean): Instance | null {
    const y = this.hf.heightAt(rec.x, rec.z);

    if (rec.kind === 'field') {
      if (this.fieldCount >= this.field.instanceMatrix.count) return null;
      const slot = this.fieldCount++;
      dummyPos.set(rec.x, y + 0.01, rec.z);
      dummyQuat.setFromAxisAngle(upAxis, rec.rot);
      const s = animate ? 0.001 : 1;
      dummyScale.set(s, s, s);
      dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
      this.field.setMatrixAt(slot, dummyMatrix);
      this.field.count = this.fieldCount;
      this.field.instanceMatrix.needsUpdate = true;

      // 3 stripe quads per field, offset along local Z, sharing the field's transform.
      // Minor 6: unlike the field's own instance (tracked in `this.animating` and rescaled every
      // frame by `update()`), these stripe instances are a *separate* InstancedMesh
      // (`this.fieldStripe`) with their own slots that `update()` never touches — composing them
      // with the animating field's `dummyScale` (0.001 while a pop-in is in flight) left them
      // permanently stuck at that near-zero scale, i.e. invisible, since nothing ever grows them
      // back to 1. They're thin decorative overlays, not a a focal pop-in element, so the simplest
      // correct fix is to always compose them at final scale (1) regardless of `animate` — worst
      // case they pop in a frame ahead of the field's own tween, which reads as fine in practice.
      dummyScale.set(1, 1, 1);
      for (let s2 = 0; s2 < 3 && this.stripeCount < this.fieldStripe.instanceMatrix.count; s2++) {
        const localZ = (s2 - 1) * (FIELD_SIZE / 3);
        // rotate the local (0, localZ) offset by rec.rot into world space
        const rx = -Math.sin(rec.rot) * localZ;
        const rz = Math.cos(rec.rot) * localZ;
        const idx = this.stripeCount++;
        dummyPos.set(rec.x + rx, y + 0.02, rec.z + rz);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        this.fieldStripe.setMatrixAt(idx, dummyMatrix);
      }
      this.fieldStripe.count = this.stripeCount;
      this.fieldStripe.instanceMatrix.needsUpdate = true;

      const instance: Instance = { kind: rec.kind, variant: { mesh: this.field, baseHeight: 0 }, slot, x: rec.x, y, z: rec.z, rot: rec.rot, windowSlot: null };
      this.instances.push(instance);
      if (animate) this.animating.push({ instance, elapsed: 0 });
      return instance;
    }

    const variant = this.pickVariant(rec.kind, rec.x, rec.z);
    if (!variant) return null; // category not ready yet and not queued (shouldn't happen; onSpawn queues first)
    if (variant.mesh.instanceMatrix.count === 0) return null;

    // find next free slot in this variant (linear scan of variant's own instance count)
    const slot = this.countFor(variant);
    if (slot >= variant.mesh.instanceMatrix.count) return null; // over capacity, drop silently

    let finalY = y;
    if (rec.kind === 'house' || rec.kind === 'building') {
      this.hf.flattenCircle(rec.x, rec.z, y, FLATTEN_RADIUS);
      finalY = this.hf.heightAt(rec.x, rec.z);
    }

    const s = animate ? 0.001 : 1;
    dummyPos.set(rec.x, finalY, rec.z);
    dummyQuat.setFromAxisAngle(upAxis, rec.rot);
    dummyScale.set(s, s, s);
    dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
    variant.mesh.setMatrixAt(slot, dummyMatrix);
    variant.mesh.count = slot + 1;
    variant.mesh.instanceMatrix.needsUpdate = true;

    let windowSlot: number | null = null;
    if (rec.kind === 'house' || rec.kind === 'building') {
      if (this.windowCount < this.windows.instanceMatrix.count) {
        windowSlot = this.windowCount++;
        const wy = finalY + variant.baseHeight * 0.5;
        const fx = Math.cos(rec.rot), fz = Math.sin(rec.rot);
        const wx = rec.x + fx * (rec.kind === 'building' ? 2.51 : 2.01);
        const wz = rec.z + fz * (rec.kind === 'building' ? 2.51 : 2.01);
        dummyPos.set(wx, wy, wz);
        dummyQuat.setFromAxisAngle(upAxis, rec.rot + Math.PI / 2);
        dummyScale.set(1, 1, 1);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        this.windows.setMatrixAt(windowSlot, dummyMatrix);
        this.windows.count = this.windowCount;
        this.windows.instanceMatrix.needsUpdate = true;
      }
    }

    const instance: Instance = { kind: rec.kind, variant, slot, x: rec.x, y: finalY, z: rec.z, rot: rec.rot, windowSlot };
    this.instances.push(instance);
    if (animate) this.animating.push({ instance, elapsed: 0 });
    return instance;
  }

  /**
   * Places sparse ambient wilderness trees (Task 31) generated once at boot from the same seed as
   * the Heightfield — rendered through the same tree InstancedMesh pool as GrowthSim's road-driven
   * trees, but with NO pop-in (instant appearance, since this is a worldgen baseline, not a live
   * spawn event) and tracked per-site so `wilderness:cleared` can later fade specific sites out.
   * If tree variants aren't loaded yet, the call is queued and flushed once they are (mirrors
   * `pendingSpawns`/`flushPending`).
   */
  setWilderness(sites: ReadonlyArray<WildernessTree>): void {
    if (!this.ready.tree) {
      this.pendingWilderness = sites.slice();
      return;
    }
    this.placeWildernessSites(sites);
  }

  private placeWildernessSites(sites: ReadonlyArray<WildernessTree>): void {
    for (const site of sites) {
      const placed: Instance[] = [];
      for (let k = 0; k < site.count; k++) {
        // Deterministic per-tree offset (no RNG needed render-side: a small hash-free spread
        // derived from the tree's index within the site keeps siblings from stacking exactly on
        // top of one another, mirroring GrowthSim's own JITTER for road-grown tree clumps).
        const angle = (k / site.count) * Math.PI * 2 + site.rot;
        const r = k === 0 ? 0 : WILDERNESS_TREE_JITTER * (0.4 + 0.6 * ((k * 37) % 7) / 6);
        const tx = site.x + Math.cos(angle) * r;
        const tz = site.z + Math.sin(angle) * r;
        const rot = site.rot + k * 2.399963; // golden-angle-ish spread so rotations don't repeat
        const instance = this.place({ kind: 'tree', x: tx, z: tz, rot }, false);
        if (instance) placed.push(instance);
      }
      this.wildernessInstancesBySite.push(placed);
    }
  }

  private flushPendingWilderness(): void {
    if (!this.pendingWilderness) return;
    const sites = this.pendingWilderness;
    this.pendingWilderness = null;
    this.placeWildernessSites(sites);
  }

  /** Fades out every placed instance belonging to the given wilderness site indices over
   * WILDERNESS_FADE_DURATION seconds (Task 31: road construction "clears" trees in its corridor). */
  private onWildernessCleared(indices: number[]): void {
    for (const siteIdx of indices) {
      const placed = this.wildernessInstancesBySite[siteIdx];
      if (!placed) continue;
      for (const instance of placed) this.fading.push({ instance, elapsed: 0 });
    }
  }

  /** Number of instances currently placed into `variant`'s InstancedMesh. */
  private countFor(variant: VariantMesh): number {
    return variant.mesh.count;
  }

  private onPhase(night: boolean): void {
    this.windowMat.emissiveIntensity = night ? WINDOW_NIGHT_INTENSITY : WINDOW_DAY_INTENSITY;
  }

  /** Rebuilds the whole scene from a saved `spawned` list with no pop-in animation (Task 15). */
  rebuild(spawned: ReadonlyArray<SpawnRecord>): void {
    this.instances = [];
    this.animating = [];
    this.pendingSpawns = [];
    this.fieldCount = 0;
    this.stripeCount = 0;
    this.windowCount = 0;
    this.field.count = 0;
    this.fieldStripe.count = 0;
    this.windows.count = 0;
    for (const v of [...this.treeVariants, ...this.houseVariants, ...this.buildingVariants]) v.mesh.count = 0;

    for (const rec of spawned) {
      if (this.categoryReady(rec.kind)) this.place(rec, false);
      else this.pendingSpawns.push({ rec, animate: false }); // restored — no pop-in once ready
    }
  }

  update(dt: number): void {
    if (this.animating.length) {
      const stillAnimating: Animating[] = [];
      for (const a of this.animating) {
        a.elapsed += dt;
        const t = clamp01(a.elapsed / POP_IN_DURATION);
        const s = Math.max(0.001, easeOutBack(t));
        dummyPos.set(a.instance.x, a.instance.y, a.instance.z);
        dummyQuat.setFromAxisAngle(upAxis, a.instance.rot);
        dummyScale.set(s, s, s);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        a.instance.variant.mesh.setMatrixAt(a.instance.slot, dummyMatrix);
        a.instance.variant.mesh.instanceMatrix.needsUpdate = true;
        if (t < 1) stillAnimating.push(a);
      }
      this.animating = stillAnimating;
    }

    if (this.fading.length) {
      const stillFading: Fading[] = [];
      for (const f of this.fading) {
        f.elapsed += dt;
        const t = clamp01(f.elapsed / WILDERNESS_FADE_DURATION);
        const s = Math.max(0.0001, 1 - t);
        dummyPos.set(f.instance.x, f.instance.y, f.instance.z);
        dummyQuat.setFromAxisAngle(upAxis, f.instance.rot);
        dummyScale.set(s, s, s);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
        f.instance.variant.mesh.setMatrixAt(f.instance.slot, dummyMatrix);
        f.instance.variant.mesh.instanceMatrix.needsUpdate = true;
        if (t < 1) stillFading.push(f);
      }
      this.fading = stillFading;
    }
  }

  dispose(): void {
    for (const v of [...this.treeVariants, ...this.houseVariants, ...this.buildingVariants]) {
      this.scene.remove(v.mesh);
      v.mesh.geometry.dispose();
      const mat = v.mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    this.scene.remove(this.field);
    this.field.geometry.dispose();
    (this.field.material as THREE.Material).dispose();
    this.scene.remove(this.fieldStripe);
    this.fieldStripe.geometry.dispose();
    (this.fieldStripe.material as THREE.Material).dispose();
    this.scene.remove(this.windows);
    this.windowGeo.dispose();
    this.windowMat.dispose();
  }
}

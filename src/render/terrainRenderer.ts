import * as THREE from 'three';
import { GRID_SIZE, WORLD_SIZE, WATER_LEVEL, CELL } from '../core/constants';
import type { Heightfield } from '../sim/terrain/heightfield';
import type { EventBus } from '../core/events';

const SAND = new THREE.Color('#c9b98a');
const GRASS = new THREE.Color('#7fae6b');
const ROCK = new THREE.Color('#8d8577');

const SAND_MAX_Y = 1;
const GRASS_MAX_Y = 14;
const ROCK_SLOPE = 0.6;

const NORMAL_RECOMPUTE_THROTTLE_MS = 100;

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly water: THREE.Mesh;
  private geo: THREE.PlaneGeometry;

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
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE * 1.5, WORLD_SIZE * 1.5, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: '#3d7ea6',
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      roughness: 0.35,
      metalness: 0.0,
    });
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.position.y = WATER_LEVEL;
    this.water.receiveShadow = true;
    scene.add(this.water);

    bus.on('terrain:deformed', ({ minI, minJ, maxI, maxJ }) => this.refreshRegion(minI, minJ, maxI, maxJ));
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

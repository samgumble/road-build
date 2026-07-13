import * as THREE from 'three';
import { ROAD_WIDTH } from '../core/constants';
import { EventBus } from '../core/events';
import { STAGES } from '../core/types';
import type { RoadSample } from '../core/types';
import { sampleAt } from '../sim/roads/path';
import type { RoadGraph } from '../sim/roads/graph';
import type { SpawnRecord } from '../sim/growth/growth';
import type { TerrainProbe } from './roadsideRenderer';

type Settlement = Pick<SpawnRecord, 'id' | 'kind' | 'x' | 'z'>;

/** Hard cap on strolling villagers — 3 instanced part meshes total, so the draw-call cost is
 * constant regardless of how many routes qualify. */
export const VILLAGER_CAP = 12;

const SETTLEMENT_REACH = 24; // u — same "this road fronts the town" radius the roadside planner uses
const STROLL_HALF = 12; // u of road either side of the settlement's nearest sample
const MIN_STROLL = 6; // u — skip windows too short to read as a walk
const VERGE_OFFSET = ROAD_WIDTH / 2 + 1.05; // just off the shoulder, clear of traffic and lamps
const WALK_SPEED = 1.1; // u/s
const BOB_HZ = 1.9;
const BOB_AMOUNT = 0.05;

const CLOTHES = ['#b7595a', '#5b7ea6', '#7a9a5f', '#c2a25a', '#8a6f9e', '#a06d55'];

export interface VillagerRoute {
  edgeId: number;
  fromT: number;
  toT: number;
  side: 1 | -1;
  seed: number;
}

/** Triangle wave 0 -> 1 -> 0 over phase 0..2 — the stroll's there-and-back parameterization. */
export function pingPong(phase: number): number {
  const u = phase % 2;
  return u <= 1 ? u : 2 - u;
}

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Pure deterministic stroll planner: one route per (painted edge, nearby settlement) pair up to
 * VILLAGER_CAP, each hugging the stretch of road its settlement fronts. Never consumes random
 * state — identical graph/settlement inputs replan identical routes (mirrors
 * `planRoadsideDetails`' contract so restores and rebuilds are stable).
 */
export function planVillagerRoutes(
  graph: RoadGraph,
  settlements: ReadonlyArray<Settlement>,
  cap = VILLAGER_CAP,
): VillagerRoute[] {
  const routes: VillagerRoute[] = [];
  const edges = [...graph.edges.values()].sort((a, b) => a.id - b.id);
  const towns = [...settlements]
    .filter((s) => s.kind === 'house' || s.kind === 'building')
    .sort((a, b) => a.id - b.id);

  for (const edge of edges) {
    if (routes.length >= cap) break;
    if (STAGES.indexOf(edge.stage as (typeof STAGES)[number]) < STAGES.indexOf('painted')) continue;
    if (edge.samples.length < 2) continue;

    // per-sample arclength walk, reused for every settlement testing this edge
    const arc: number[] = [0];
    for (let i = 1; i < edge.samples.length; i++) {
      const a = edge.samples[i - 1], b = edge.samples[i];
      arc.push(arc[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = arc[arc.length - 1];

    for (const town of towns) {
      if (routes.length >= cap) break;
      let bestDist = Infinity;
      let bestArc = 0;
      let bestBridge = false;
      for (let i = 0; i < edge.samples.length; i++) {
        const s: RoadSample = edge.samples[i];
        const d = Math.hypot(s.x - town.x, s.z - town.z);
        if (d < bestDist) {
          bestDist = d;
          bestArc = arc[i];
          bestBridge = !!s.bridge;
        }
      }
      if (bestDist > SETTLEMENT_REACH || bestBridge) continue;
      const fromT = Math.max(0, bestArc - STROLL_HALF);
      const toT = Math.min(total, bestArc + STROLL_HALF);
      if (toT - fromT < MIN_STROLL) continue;
      routes.push({
        edgeId: edge.id,
        fromT,
        toT,
        side: town.id % 2 === 0 ? 1 : -1,
        seed: edge.id * 8191 + town.id,
      });
    }
  }
  return routes;
}

/**
 * A handful of tiny strolling figures on painted streets near grown settlements — pure render
 * theater like the construction workers (no sim contract, no save state). Three shared
 * InstancedMeshes (legs/torso/head) keep the draw cost at 3 calls for the whole population; the
 * per-frame work is VILLAGER_CAP matrix writes. Villagers stroll by day and go home at night
 * (whole-group visibility gate off the same `atmosphere:phase` event the window glow uses).
 */
export class VillagerRenderer {
  private readonly group = new THREE.Group();
  private readonly legs: THREE.InstancedMesh;
  private readonly torso: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly settlements = new Map<number, Settlement>();
  private routes: VillagerRoute[] = [];
  private phases: number[] = [];
  private night = false;
  private readonly dummy = new THREE.Object3D();

  constructor(
    private scene: THREE.Scene,
    private graph: RoadGraph,
    private terrain: TerrainProbe,
    bus: EventBus,
  ) {
    this.group.name = 'villagers';
    this.scene.add(this.group);

    const part = (geo: THREE.BoxGeometry, color: number) => {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }), VILLAGER_CAP);
      mesh.castShadow = true;
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    this.torso = part(new THREE.BoxGeometry(0.34, 0.5, 0.24), 0xffffff); // per-instance colored below
    this.legs = part(new THREE.BoxGeometry(0.26, 0.4, 0.2), 0x3d3a36);
    this.head = part(new THREE.BoxGeometry(0.2, 0.2, 0.18), 0xd9b38c);

    const replan = () => this.replan();
    bus.on('roads:edgeAdded', replan);
    bus.on('roads:edgeRemoved', replan);
    bus.on('construction:stage', replan);
    bus.on('growth:spawn', (record) => {
      if ((record.kind === 'house' || record.kind === 'building') && record.id !== undefined) {
        this.settlements.set(record.id, { id: record.id, kind: record.kind, x: record.x, z: record.z });
        this.replan();
      }
    });
    bus.on('growth:upgrade', ({ id }) => {
      const record = this.settlements.get(id);
      if (record) { record.kind = 'building'; this.replan(); }
    });
    bus.on('growth:remove', ({ id }) => {
      if (this.settlements.delete(id)) this.replan();
    });
    bus.on('atmosphere:phase', ({ night }) => {
      this.night = night;
      this.group.visible = !night;
    });
  }

  setSettlements(records: ReadonlyArray<Settlement>): void {
    this.settlements.clear();
    for (const record of records) {
      if (record.kind === 'house' || record.kind === 'building') this.settlements.set(record.id, { ...record });
    }
    this.replan();
  }

  private replan(): void {
    this.routes = planVillagerRoutes(this.graph, [...this.settlements.values()]);
    // Seeded starting phases so a replan doesn't snap everyone back to their route start, and two
    // villagers sharing a stretch don't walk in lockstep.
    this.phases = this.routes.map((route) => hash01(route.seed) * 2);
  }

  /** Advances every stroll; render-frame dt (villagers are wall-of-the-world theater, so they keep
   * ambling at any sim speed rather than sprinting at 16x). Skipped entirely at night. */
  update(dt: number): void {
    if (this.night) return;
    const count = this.routes.length;
    for (let i = 0; i < count; i++) {
      const route = this.routes[i];
      const edge = this.graph.edges.get(route.edgeId);
      if (!edge) continue;
      const span = route.toT - route.fromT;
      this.phases[i] += (dt * WALK_SPEED) / span;
      const phase = this.phases[i];
      const u = pingPong(phase);
      const t = route.fromT + u * span;
      const { pos, heading } = sampleAt(edge.samples, t);
      const outbound = phase % 2 <= 1;
      const facing = outbound ? heading : heading + Math.PI;
      const px = -Math.sin(heading) * VERGE_OFFSET * route.side;
      const pz = Math.cos(heading) * VERGE_OFFSET * route.side;
      const x = pos.x + px;
      const z = pos.z + pz;
      const bob = Math.abs(Math.sin(phase * span * (BOB_HZ / WALK_SPEED) * Math.PI)) * BOB_AMOUNT;
      const y = this.terrain.heightAt(x, z) + bob;

      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, -facing, 0);
      this.dummy.scale.setScalar(1);

      this.dummy.position.y = y + 0.2;
      this.dummy.updateMatrix();
      this.legs.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.y = y + 0.65;
      this.dummy.updateMatrix();
      this.torso.setMatrixAt(i, this.dummy.matrix);
      this.torso.setColorAt(i, new THREE.Color(CLOTHES[route.seed % CLOTHES.length]));
      this.dummy.position.y = y + 1.0;
      this.dummy.updateMatrix();
      this.head.setMatrixAt(i, this.dummy.matrix);
    }
    for (const mesh of [this.legs, this.torso, this.head]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.torso.instanceColor) this.torso.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.legs, this.torso, this.head]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.scene.remove(this.group);
  }
}

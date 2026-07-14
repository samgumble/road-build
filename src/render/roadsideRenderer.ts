import * as THREE from 'three';
import { ROAD_WIDTH } from '../core/constants';
import { EventBus } from '../core/events';
import { STAGES } from '../core/types';
import type { RoadSample } from '../core/types';
import type { SpawnRecord } from '../sim/growth/growth';
import type { RoadGraph } from '../sim/roads/graph';

export interface DetailPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  scale?: number;
}

export interface RoadsidePlan {
  culverts: DetailPose[];
  retainingWalls: DetailPose[];
  guardrails: DetailPose[];
  reflectors: DetailPose[];
  signs: DetailPose[];
  utilityPoles: DetailPose[];
  gravelScatter: DetailPose[];
  /** Night-glowing lamps on painted stretches near settlements — the town's own side of the
   * street (utility poles take the other side/parity, so the two never stack on one station). */
  streetlamps: DetailPose[];
}

export interface TerrainProbe {
  heightAt(x: number, z: number): number;
  isLand(x: number, z: number): boolean;
}

type Settlement = Pick<SpawnRecord, 'id' | 'kind' | 'x' | 'z'>;

const DETAIL_OFFSET = ROAD_WIDTH / 2 + 2.1;
const SAMPLE_SPACING = 12;
// Keep cosmetic props (gravel, reflectors, poles, lamps, culverts) at least this far from a
// degree-3+ node: the junction apron (5u reach + shoulder width) plus a small margin.
const JUNCTION_PROP_CLEARANCE = 10;

function headingAt(samples: RoadSample[], i: number): number {
  const a = samples[Math.max(0, i - 1)];
  const b = samples[Math.min(samples.length - 1, i + 1)];
  return Math.atan2(b.z - a.z, b.x - a.x);
}

function poseAt(sample: RoadSample, heading: number, side: number, terrain: TerrainProbe): DetailPose {
  const px = -Math.sin(heading);
  const pz = Math.cos(heading);
  const x = sample.x + px * DETAIL_OFFSET * side;
  const z = sample.z + pz * DETAIL_OFFSET * side;
  return { x, y: terrain.heightAt(x, z), z, heading };
}

function developed(stage: string, atLeast: 'graded' | 'painted'): boolean {
  return STAGES.indexOf(stage as (typeof STAGES)[number]) >= STAGES.indexOf(atLeast);
}

/** Pure deterministic context planner. It samples fixed arclength intervals and never consumes
 * random state, so rebuilding the same road/terrain/settlement state produces identical props. */
export function planRoadsideDetails(
  graph: RoadGraph,
  terrain: TerrainProbe,
  settlements: ReadonlyArray<Settlement>,
): RoadsidePlan {
  const plan: RoadsidePlan = {
    culverts: [], retainingWalls: [], guardrails: [], reflectors: [], signs: [], utilityPoles: [],
    gravelScatter: [], streetlamps: [],
  };

  // Cosmetic furniture stays out of intersection aprons: RoadRenderer owns everything inside a
  // degree-3+ node's conflict area, and props planted there read as construction debris.
  const junctionNodes = [...graph.nodes.values()].filter((node) => graph.edgesAtNode(node.id).length >= 3);
  const nearJunction = (x: number, z: number) =>
    junctionNodes.some((node) => Math.hypot(node.x - x, node.z - z) <= JUNCTION_PROP_CLEARANCE);

  for (const edge of graph.edges.values()) {
    if (!developed(edge.stage, 'graded') || edge.samples.length < 2) continue;
    let walked = 0;
    let nextStation = SAMPLE_SPACING;
    let stationIndex = 0;
    for (let i = 1; i < edge.samples.length; i++) {
      const prev = edge.samples[i - 1];
      const sample = edge.samples[i];
      walked += Math.hypot(sample.x - prev.x, sample.z - prev.z);
      if (walked < nextStation) continue;
      nextStation += SAMPLE_SPACING;
      stationIndex++;
      if (sample.bridge) continue;

      const heading = headingAt(edge.samples, i);
      const left = poseAt(sample, heading, 1, terrain);
      const right = poseAt(sample, heading, -1, terrain);
      const leftLand = terrain.isLand(left.x, left.z);
      const rightLand = terrain.isLand(right.x, right.z);
      const leftDrop = sample.y - left.y;
      const rightDrop = sample.y - right.y;

      if (!leftLand || leftDrop > 1.35) plan.guardrails.push(left);
      if (!rightLand || rightDrop > 1.35) plan.guardrails.push(right);

      const crossSlope = Math.abs(left.y - right.y);
      if (crossSlope > 1.6) plan.retainingWalls.push(left.y < right.y ? left : right);

      // Safety furniture (rails, walls) stands wherever the terrain demands it; everything below
      // is cosmetic and stays out of intersection aprons.
      const inApron = nearJunction(sample.x, sample.z);

      if (!inApron && (!leftLand || !rightLand) && stationIndex % 2 === 1) {
        plan.culverts.push(
          { ...left, y: left.y + 0.18 },
          { ...right, y: right.y + 0.18 },
        );
      }

      if (!inApron && i > 1 && i < edge.samples.length - 1) {
        const h0 = headingAt(edge.samples, i - 1);
        let turn = heading - h0;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        if (Math.abs(turn) > 0.08) {
          plan.reflectors.push(left, right);
        }
      }

      if (developed(edge.stage, 'painted') && !inApron) {
        plan.gravelScatter.push({ ...left, scale: 0.7 }, { ...right, scale: 0.55 });
        const nearSettlement = settlements.some((s) =>
          (s.kind === 'house' || s.kind === 'building') && Math.hypot(s.x - sample.x, s.z - sample.z) <= 24,
        );
        if (nearSettlement && stationIndex % 2 === 0) plan.utilityPoles.push(left);
        if (nearSettlement && stationIndex % 2 === 1) plan.streetlamps.push(right);
      }
    }
  }

  for (const node of graph.nodes.values()) {
    const edgeIds = graph.edgesAtNode(node.id);
    const painted = edgeIds.some((id) => {
      const edge = graph.edges.get(id);
      return edge && developed(edge.stage, 'painted');
    });
    if (!painted || edgeIds.length < 3) continue;
    const y = terrain.heightAt(node.x, node.z);
    const first = graph.edges.get(edgeIds[0]);
    const heading = first ? headingAt(first.samples, first.a === node.id ? 0 : first.samples.length - 1) : 0;
    const sample = { x: node.x, y, z: node.z, bridge: false };
    plan.signs.push(poseAt(sample, heading, 1, terrain));
  }

  return plan;
}

interface PoolSpec {
  mesh: THREE.InstancedMesh;
  poses: (plan: RoadsidePlan) => DetailPose[];
  yOffset: number;
  scale: THREE.Vector3;
  rotate?: (pose: DetailPose) => THREE.Quaternion;
}

function material(color: number, emissive = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.82, metalness: color === 0x9a9b93 ? 0.45 : 0,
    emissive, emissiveIntensity: emissive ? 0.7 : 0,
  });
}

/** Bounded, fixed-draw-call roadside furniture renderer. Every pool is rewritten only when graph
 * stage/topology or settlement context changes—not per frame. */
const LAMP_HEAD_NIGHT_INTENSITY = 1.6;
const LAMP_HEAD_DAY_INTENSITY = 0.08;
const LAMP_GLOW_NIGHT_OPACITY = 0.3;

export class RoadsideRenderer {
  private readonly group = new THREE.Group();
  private readonly pools: PoolSpec[] = [];
  private readonly settlements = new Map<number, Settlement>();
  private readonly lampHeadMat: THREE.MeshStandardMaterial;
  private readonly lampGlowMat: THREE.MeshBasicMaterial;
  private night = false;

  constructor(
    private scene: THREE.Scene,
    private graph: RoadGraph,
    private terrain: TerrainProbe,
    bus: EventBus,
  ) {
    this.group.name = 'roadside-context-details';
    this.scene.add(this.group);

    const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, capacity: number,
      poses: PoolSpec['poses'], yOffset: number, scale: THREE.Vector3, rotate?: PoolSpec['rotate']) => {
      const mesh = new THREE.InstancedMesh(geometry, mat, capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.group.add(mesh);
      this.pools.push({ mesh, poses, yOffset, scale, rotate });
    };

    const yaw = (pose: DetailPose) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -pose.heading, 0));
    add(new THREE.BoxGeometry(5.5, 0.16, 0.14), material(0x9a9b93), 700, (p) => p.guardrails, 0.72, new THREE.Vector3(1, 1, 1), yaw);
    add(new THREE.BoxGeometry(0.12, 0.72, 0.12), material(0x666864), 700, (p) => p.guardrails, 0.36, new THREE.Vector3(1, 1, 1));
    add(new THREE.BoxGeometry(5.5, 1.2, 0.42), material(0x756b58), 500, (p) => p.retainingWalls, 0.58, new THREE.Vector3(1, 1, 1), yaw);
    add(new THREE.TorusGeometry(0.36, 0.1, 6, 10), material(0x575d59), 300, (p) => p.culverts, 0.18, new THREE.Vector3(1, 1, 1),
      (pose) => new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, -pose.heading, 0)));
    add(new THREE.BoxGeometry(0.12, 0.18, 0.08), material(0xd9aa45, 0xd9aa45), 900, (p) => p.reflectors, 0.12, new THREE.Vector3(1, 1, 1), yaw);
    add(new THREE.BoxGeometry(0.09, 1.7, 0.09), material(0x4b4338), 220, (p) => p.signs, 0.85, new THREE.Vector3(1, 1, 1));
    add(new THREE.BoxGeometry(0.72, 0.58, 0.08), material(0xd8c9a3), 220, (p) => p.signs, 1.55, new THREE.Vector3(1, 1, 1), yaw);
    add(new THREE.CylinderGeometry(0.09, 0.13, 5.2, 6), material(0x4c3928), 420, (p) => p.utilityPoles, 2.6, new THREE.Vector3(1, 1, 1));
    add(new THREE.BoxGeometry(1.6, 0.1, 0.1), material(0x403328), 420, (p) => p.utilityPoles, 5.0, new THREE.Vector3(1, 1, 1), yaw);
    add(new THREE.IcosahedronGeometry(0.16, 0), material(0x8f8879), 900, (p) => p.gravelScatter, 0.12, new THREE.Vector3(1, 0.55, 1), yaw);

    // Streetlamps (Living Towns atmosphere): pole + warm emissive head + a fake additive ground
    // light pool. Real lights stay out of budget — the glow is a flat disc whose opacity (and the
    // head's emissive) gates on the day/night phase via `setNight`, exactly like the scenery
    // renderer's window glow.
    this.lampHeadMat = new THREE.MeshStandardMaterial({
      color: 0xffe9c4, roughness: 0.5, emissive: 0xffc873, emissiveIntensity: LAMP_HEAD_DAY_INTENSITY,
      toneMapped: false,
    });
    this.lampGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffc873, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    add(new THREE.CylinderGeometry(0.055, 0.085, 3.4, 6), material(0x36393c), 260, (p) => p.streetlamps, 1.7, new THREE.Vector3(1, 1, 1));
    const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.13, 0.2), this.lampHeadMat, 260);
    headMesh.name = 'streetlamp-heads';
    headMesh.castShadow = true;
    headMesh.count = 0;
    this.group.add(headMesh);
    this.pools.push({ mesh: headMesh, poses: (p) => p.streetlamps, yOffset: 3.42, scale: new THREE.Vector3(1, 1, 1), rotate: yaw });
    const glowGeo = new THREE.CircleGeometry(2.4, 18);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMesh = new THREE.InstancedMesh(glowGeo, this.lampGlowMat, 260);
    glowMesh.name = 'streetlamp-glow';
    glowMesh.count = 0;
    this.group.add(glowMesh);
    this.pools.push({ mesh: glowMesh, poses: (p) => p.streetlamps, yOffset: 0.07, scale: new THREE.Vector3(1, 1, 1) });

    bus.on('atmosphere:phase', ({ night }) => this.setNight(night));

    const rebuild = () => this.rebuild();
    bus.on('roads:edgeAdded', rebuild);
    bus.on('roads:edgeRemoved', rebuild);
    bus.on('construction:stage', rebuild);
    bus.on('growth:spawn', (record) => {
      if ((record.kind === 'house' || record.kind === 'building') && record.id !== undefined) {
        this.settlements.set(record.id, { id: record.id, kind: record.kind, x: record.x, z: record.z });
        this.rebuild();
      }
    });
    bus.on('growth:upgrade', ({ id }) => {
      const record = this.settlements.get(id);
      if (record) { record.kind = 'building'; this.rebuild(); }
    });
    bus.on('growth:remove', ({ id }) => {
      if (this.settlements.delete(id)) this.rebuild();
    });
  }

  /** Day/night gate for the lamp heads + ground pools (also driven by the `atmosphere:phase`
   * event; public so tests and manual callers can flip it directly). */
  setNight(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    this.lampHeadMat.emissiveIntensity = night ? LAMP_HEAD_NIGHT_INTENSITY : LAMP_HEAD_DAY_INTENSITY;
    this.lampGlowMat.opacity = night ? LAMP_GLOW_NIGHT_OPACITY : 0;
  }

  setSettlements(records: ReadonlyArray<Settlement>): void {
    this.settlements.clear();
    for (const record of records) {
      if (record.kind === 'house' || record.kind === 'building') this.settlements.set(record.id, { ...record });
    }
    this.rebuild();
  }

  rebuild(): void {
    const plan = planRoadsideDetails(this.graph, this.terrain, [...this.settlements.values()]);
    const dummy = new THREE.Object3D();
    for (const pool of this.pools) {
      const poses = pool.poses(plan);
      const count = Math.min(pool.mesh.instanceMatrix.count, poses.length);
      for (let i = 0; i < count; i++) {
        const pose = poses[i];
        dummy.position.set(pose.x, pose.y + pool.yOffset, pose.z);
        dummy.quaternion.copy(pool.rotate ? pool.rotate(pose) : new THREE.Quaternion());
        const s = pose.scale ?? 1;
        dummy.scale.copy(pool.scale).multiplyScalar(s);
        dummy.updateMatrix();
        pool.mesh.setMatrixAt(i, dummy.matrix);
      }
      pool.mesh.count = count;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const { mesh } of this.pools) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.scene.remove(this.group);
  }
}

import * as THREE from 'three';
import type { VehicleKind } from '../core/types';
import { EventBus } from '../core/events';
import { RoadGraph } from '../sim/roads/graph';
import { sampleAt } from '../sim/roads/path';
import { damp, easeOutCubic, clamp01 } from './easing';

const CAB_COLOR = '#e8641b';
const BODY_COLOR = '#3c3f41';
const WHEEL_COLOR = '#1c1d1e';
const BEACON_COLOR = '#ffb020';

const BEACON_HZ = 2;
const BOOM_HZ = 0.4;
const BOOM_AMPLITUDE = THREE.MathUtils.degToRad(10);

const POS_LAMBDA = 10;
const ROT_LAMBDA = 10;

const FADE_DURATION = 0.4; // seconds, easeOutCubic scale-in/out

const ROLLER_TRAIL_DISTANCE = 8;

const DUST_INTERVAL = 0.5; // seconds between bursts while grading/demolishing
const DUST_BURST_COUNT = 8;
const DUST_LIFETIME = 0.8;
const DUST_SIZE = 1.2;
const DUST_COLOR = '#a08a68';
const DUST_POOL_SIZE = 200;

const STEAM_INTERVAL = 0.35;
const STEAM_BURST_COUNT = 4;
const STEAM_LIFETIME = 1.6;
const STEAM_SIZE = 1.6;
const STEAM_COLOR = '#dcdcd6';
const STEAM_POOL_SIZE = 100;

function flatMat(color: string, emissive?: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.85,
    emissive: emissive ?? '#000000',
    emissiveIntensity: emissive ? 1 : 0,
  });
}

function wheelCylinder(radius: number, width: number): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, width, 10);
  geo.rotateZ(Math.PI / 2);
  return geo;
}

/** A vehicle's root group plus any named sub-parts that need per-frame animation. */
interface VehicleRig {
  kind: VehicleKind;
  group: THREE.Group;
  beaconMat: THREE.MeshStandardMaterial;
  boom?: THREE.Group; // excavator only — bobs while working
  materials: THREE.MeshStandardMaterial[];
}

function addBeacon(parent: THREE.Object3D, y: number): THREE.MeshStandardMaterial {
  const mat = flatMat(BEACON_COLOR, BEACON_COLOR);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), mat);
  mesh.position.set(0, y, 0);
  parent.add(mesh);
  return mat;
}

function buildExcavator(): VehicleRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat);

  // tracked base
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.6, 1.8), wheelMat);
  base.position.y = 0.3;
  group.add(base);

  // rotating cab (turret) — separate group so it can rotate independently later if desired
  const cab = new THREE.Group();
  cab.position.y = 0.6;
  group.add(cab);

  const cabBody = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.5), cabMat);
  cabBody.position.set(-0.2, 0.45, 0);
  cab.add(cabBody);

  // boom arm: pivots at the front of the cab, bobs while working
  const boom = new THREE.Group();
  boom.position.set(0.6, 0.7, 0);
  cab.add(boom);

  const boomArm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.35, 0.35), bodyMat);
  boomArm.position.set(1.1, 0.2, 0);
  boomArm.rotation.z = -0.3;
  boom.add(boomArm);

  const stick = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.28), bodyMat);
  stick.position.set(2.3, -0.6, 0);
  stick.rotation.z = 0.9;
  boom.add(stick);

  const bucket = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.6), bodyMat);
  bucket.position.set(2.9, -1.2, 0);
  boom.add(bucket);

  const beaconMat = addBeacon(cab, 1.05);

  return { kind: 'excavator', group, beaconMat, boom, materials };
}

function buildTruck(): VehicleRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.5), cabMat);
  cab.position.set(1.4, 0.85, 0);
  group.add(cab);

  // tipping bed — slight upward tilt to read as a dump truck bed
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1.7), bodyMat);
  bed.position.set(-0.6, 0.85, 0);
  bed.rotation.z = 0.05;
  group.add(bed);

  const wheelGeo = wheelCylinder(0.45, 1.9);
  for (const x of [-1.3, 0, 1.4]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.45, 0);
    group.add(wheel);
  }

  const beaconMat = addBeacon(cab, 0.9);

  return { kind: 'truck', group, beaconMat, materials };
}

function buildPaver(): VehicleRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat);

  // low slab chassis
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.4, 1.9), bodyMat);
  slab.position.y = 0.3;
  group.add(slab);

  // hopper at the front (direction of travel is +x in local space)
  const hopper = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 1.8), bodyMat);
  hopper.position.set(1.2, 0.65, 0);
  group.add(hopper);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 1.1), cabMat);
  cab.position.set(-0.6, 0.75, 0);
  group.add(cab);

  const trackGeo = wheelCylinder(0.35, 1.7);
  for (const x of [-1.1, 0.9]) {
    const track = new THREE.Mesh(trackGeo, wheelMat);
    track.position.set(x, 0.2, 0);
    group.add(track);
  }

  const beaconMat = addBeacon(cab, 0.5);

  return { kind: 'paver', group, beaconMat, materials };
}

function buildRoller(): VehicleRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const drumMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, drumMat);

  // big front drum
  const drum = new THREE.Mesh(wheelCylinder(0.65, 1.8), drumMat);
  drum.position.set(1.1, 0.65, 0);
  group.add(drum);

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.3), bodyMat);
  chassis.position.set(-0.5, 0.75, 0);
  group.add(chassis);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 1.0), cabMat);
  cab.position.set(-0.8, 1.25, 0);
  group.add(cab);

  const rearWheelGeo = wheelCylinder(0.5, 1.6);
  const rearWheel = new THREE.Mesh(rearWheelGeo, drumMat);
  rearWheel.position.set(-1.3, 0.5, 0);
  group.add(rearWheel);

  const beaconMat = addBeacon(cab, 0.5);

  return { kind: 'roller', group, beaconMat, materials };
}

function buildLiner(): VehicleRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.3), cabMat);
  cab.position.set(0.8, 0.7, 0);
  group.add(cab);

  const bed = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.3), bodyMat);
  bed.position.set(-0.5, 0.6, 0);
  group.add(bed);

  // rear nozzle assembly trailing behind (-x, toward the back of the vehicle)
  const nozzleArm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.15), bodyMat);
  nozzleArm.position.set(-1.4, 0.3, 0);
  group.add(nozzleArm);

  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), wheelMat);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(-1.7, 0.2, 0);
  group.add(nozzle);

  const wheelGeo = wheelCylinder(0.35, 1.4);
  for (const x of [-0.8, 0.9]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.35, 0);
    group.add(wheel);
  }

  const beaconMat = addBeacon(cab, 0.75);

  return { kind: 'liner', group, beaconMat, materials };
}

/** Per-vehicle animation/visibility state, independent of the rig's static geometry. */
interface VehicleState {
  rig: VehicleRig;
  curPos: THREE.Vector3;
  curHeading: number;
  targetPos: THREE.Vector3;
  targetHeading: number;
  scale: number; // current animated scale, 0..1
  fadeElapsed: number; // 0 (hidden) .. 1 (fully shown), eased into `scale` via easeOutCubic
  hasTarget: boolean; // false until the first progress event positions this vehicle
}

/**
 * Fixed-capacity, pre-allocated THREE.Points pool. `spawn()` overwrites the oldest available
 * slot (ring-buffer style) with a fresh particle; `update()` advances ages and writes only the
 * live slots' attributes, sliding dead ones out of view (huge Y) with alpha 0 so no per-frame
 * allocation ever occurs.
 */
class ParticlePool {
  private readonly capacity: number;
  private readonly lifetime: number;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly alive: Uint8Array;
  private cursor = 0;
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;

  constructor(capacity: number, size: number, color: string, lifetime: number) {
    this.capacity = capacity;
    this.lifetime = lifetime;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity).fill(Infinity);
    this.alive = new Uint8Array(capacity);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.ages[i] = 0;
    this.alive[i] = 1;
  }

  update(dt: number): void {
    let maxAlive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.ages[i] += dt;
      if (this.ages[i] >= this.lifetime) {
        this.alive[i] = 0;
        // park dead particles far below the world so they never render even within draw range
        this.positions[i * 3 + 1] = -9999;
        continue;
      }
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      maxAlive = i + 1;
    }
    this.geo.setDrawRange(0, maxAlive);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/**
 * Renders the active construction crew's vehicle for each in-progress job, plus the trailing
 * roller during `paved` and dust/steam particle effects. One `VehicleRig` per `VehicleKind` is
 * built once at startup and hidden; only the vehicle(s) relevant to the currently-streaming
 * `construction:progress` events are shown, damping toward the reported position/heading and
 * fading in/out via scale so nothing pops.
 */
export class ConstructionRenderer {
  private rigs: Record<VehicleKind, VehicleRig>;
  private states: Map<VehicleKind, VehicleState> = new Map();
  private roller: VehicleState;

  private dustPool: ParticlePool;
  private steamPool: ParticlePool;
  private dustTimer = 0;
  private steamTimer = 0;

  private clock = 0;
  // last-seen progress event per non-roller vehicle kind, used to detect "job stopped this frame"
  private lastSeenAt: Map<VehicleKind, number> = new Map();
  private lastRollerSeenAt = -Infinity;
  private readonly IDLE_TIMEOUT = 0.2; // seconds without a progress event => job considered done

  constructor(
    private scene: THREE.Scene,
    bus: EventBus,
    private graph: RoadGraph,
  ) {
    this.rigs = {
      excavator: buildExcavator(),
      truck: buildTruck(),
      paver: buildPaver(),
      roller: buildRoller(),
      liner: buildLiner(),
    };
    for (const kind of Object.keys(this.rigs) as VehicleKind[]) {
      const rig = this.rigs[kind];
      rig.group.visible = false;
      rig.group.scale.setScalar(0.001);
      this.scene.add(rig.group);
    }

    // 'roller' is never itself a target `vehicle` on a progress event (queue.ts only ever emits
    // excavator/truck/paver/liner) — it only trails the paver during 'paved', so its state is
    // driven exclusively by the synthetic trailing-position logic in onProgress()/update() below.
    this.roller = this.makeState(this.rigs.roller);

    this.dustPool = new ParticlePool(DUST_POOL_SIZE, DUST_SIZE, DUST_COLOR, DUST_LIFETIME);
    this.steamPool = new ParticlePool(STEAM_POOL_SIZE, STEAM_SIZE, STEAM_COLOR, STEAM_LIFETIME);
    this.scene.add(this.dustPool.points);
    this.scene.add(this.steamPool.points);

    bus.on('construction:progress', (e) => this.onProgress(e));
  }

  private makeState(rig: VehicleRig): VehicleState {
    return {
      rig,
      curPos: new THREE.Vector3(),
      curHeading: 0,
      targetPos: new THREE.Vector3(),
      targetHeading: 0,
      scale: 0,
      fadeElapsed: 0,
      hasTarget: false,
    };
  }

  private stateFor(kind: VehicleKind): VehicleState {
    let s = this.states.get(kind);
    if (!s) {
      s = this.makeState(this.rigs[kind]);
      this.states.set(kind, s);
    }
    return s;
  }

  private onProgress(e: {
    edgeId: number;
    stage: string;
    t: number;
    pos: { x: number; y: number; z: number };
    heading: number;
    vehicle: VehicleKind;
    demolish: boolean;
  }): void {
    const state = this.stateFor(e.vehicle);
    state.targetPos.set(e.pos.x, e.pos.y, e.pos.z);
    state.targetHeading = e.heading;
    if (!state.hasTarget) {
      // snap on first sighting so it doesn't damp in from the origin
      state.curPos.copy(state.targetPos);
      state.curHeading = state.targetHeading;
      state.hasTarget = true;
    }
    this.lastSeenAt.set(e.vehicle, this.clock);

    // Dust/steam bursts are driven by timers in update() (see there), not per-event — progress
    // events fire at 60/s and would otherwise blow through the particle pool in a fraction of a
    // second. This handler only tracks liveness + (for 'paved') the trailing roller's target.

    if (e.stage === 'paved') {
      const edge = this.graph.edges.get(e.edgeId);
      if (edge) {
        const rollerT = Math.max(0, e.t - ROLLER_TRAIL_DISTANCE);
        const { pos, heading } = sampleAt(edge.samples, rollerT);
        this.roller.targetPos.set(pos.x, pos.y, pos.z);
        this.roller.targetHeading = e.demolish ? heading + Math.PI : heading;
        if (!this.roller.hasTarget) {
          this.roller.curPos.copy(this.roller.targetPos);
          this.roller.curHeading = this.roller.targetHeading;
          this.roller.hasTarget = true;
        }
        this.lastRollerSeenAt = this.clock;
      }
    }
  }

  private emitDust(x: number, y: number, z: number): void {
    for (let i = 0; i < DUST_BURST_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 0.8;
      this.dustPool.spawn(
        x + (Math.random() - 0.5) * 1.5,
        y + 0.2,
        z + (Math.random() - 0.5) * 1.5,
        Math.cos(angle) * speed,
        1.2 + Math.random() * 1.0,
        Math.sin(angle) * speed,
      );
    }
  }

  private emitSteam(x: number, y: number, z: number): void {
    for (let i = 0; i < STEAM_BURST_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.2 + Math.random() * 0.3;
      this.steamPool.spawn(
        x + (Math.random() - 0.5) * 0.8,
        y + 0.6,
        z + (Math.random() - 0.5) * 0.8,
        Math.cos(angle) * speed,
        0.6 + Math.random() * 0.5,
        Math.sin(angle) * speed,
      );
    }
  }

  /** Damps position/heading toward the last-reported target, advances fade scale toward `active`, and applies the result to the rig's THREE.Group. */
  private stepVehicle(state: VehicleState, dt: number, active: boolean): void {
    if (!state.hasTarget) return;

    state.curPos.x = damp(state.curPos.x, state.targetPos.x, POS_LAMBDA, dt);
    state.curPos.y = damp(state.curPos.y, state.targetPos.y, POS_LAMBDA, dt);
    state.curPos.z = damp(state.curPos.z, state.targetPos.z, POS_LAMBDA, dt);

    // shortest-path angle damping
    let delta = state.targetHeading - state.curHeading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    state.curHeading = state.curHeading + delta * (1 - Math.exp(-ROT_LAMBDA * dt));

    const direction = active ? 1 : -1;
    state.fadeElapsed = clamp01(state.fadeElapsed + direction * (dt / FADE_DURATION));
    // `fadeElapsed` always represents "progress toward fully shown" (1 = fully visible, 0 = fully
    // hidden); ease it so scale-in/out both use easeOutCubic rather than linear interpolation.
    state.scale = easeOutCubic(state.fadeElapsed);

    const rig = state.rig;
    rig.group.visible = state.scale > 0.001;
    rig.group.position.copy(state.curPos);
    rig.group.rotation.y = -state.curHeading;
    rig.group.scale.setScalar(Math.max(0.001, state.scale));
  }

  update(dt: number, night: boolean): void {
    this.clock += dt;

    // determine which vehicle kinds are "active" this frame: they received a progress event
    // within IDLE_TIMEOUT seconds (guards against a single stray frame gap causing a pop).
    for (const [kind, state] of this.states) {
      const lastSeen = this.lastSeenAt.get(kind) ?? -Infinity;
      const active = this.clock - lastSeen <= this.IDLE_TIMEOUT;
      this.stepVehicle(state, dt, active);
    }
    const rollerActive = this.clock - this.lastRollerSeenAt <= this.IDLE_TIMEOUT;
    this.stepVehicle(this.roller, dt, rollerActive);

    // beacon pulse: sin-based intensity 0.4..1.6 at 2Hz, doubled at night
    const pulsePhase = Math.sin(2 * Math.PI * BEACON_HZ * this.clock);
    const beaconIntensity = (1.0 + 0.6 * pulsePhase) * (night ? 2 : 1);
    for (const kind of Object.keys(this.rigs) as VehicleKind[]) {
      this.rigs[kind].beaconMat.emissiveIntensity = beaconIntensity;
    }

    // excavator boom bob while actively grading/demolishing, and periodic dust bursts at its
    // current (damped) position — driven by a single "is the excavator working right now" check.
    const excavatorState = this.states.get('excavator');
    const excavatorActive =
      this.clock - (this.lastSeenAt.get('excavator') ?? -Infinity) <= this.IDLE_TIMEOUT;

    if (excavatorActive) {
      this.rigs.excavator.boom!.rotation.z = Math.sin(2 * Math.PI * BOOM_HZ * this.clock) * BOOM_AMPLITUDE;
    }

    if (excavatorState && excavatorActive) {
      this.dustTimer += dt;
      if (this.dustTimer >= DUST_INTERVAL) {
        this.dustTimer = 0;
        this.emitDust(excavatorState.curPos.x, excavatorState.curPos.y, excavatorState.curPos.z);
      }
    } else {
      this.dustTimer = 0;
    }

    if (this.clock - this.lastRollerSeenAt <= this.IDLE_TIMEOUT) {
      this.steamTimer += dt;
      if (this.steamTimer >= STEAM_INTERVAL) {
        this.steamTimer = 0;
        this.emitSteam(this.roller.curPos.x, this.roller.curPos.y, this.roller.curPos.z);
      }
    } else {
      this.steamTimer = 0;
    }

    this.dustPool.update(dt);
    this.steamPool.update(dt);
  }

  dispose(): void {
    for (const kind of Object.keys(this.rigs) as VehicleKind[]) {
      const rig = this.rigs[kind];
      this.scene.remove(rig.group);
      rig.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
        }
      });
      for (const m of rig.materials) m.dispose();
      rig.beaconMat.dispose();
    }
    this.scene.remove(this.dustPool.points);
    this.scene.remove(this.steamPool.points);
    this.dustPool.dispose();
    this.steamPool.dispose();
  }
}

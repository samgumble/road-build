import * as THREE from 'three';
import type { VehicleKind } from '../core/types';
import { EventBus } from '../core/events';
import { RoadGraph } from '../sim/roads/graph';
import { sampleAt } from '../sim/roads/path';
import { Heightfield } from '../sim/terrain/heightfield';
import { damp, easeOutCubic, clamp01 } from './easing';
import { ROAD_WIDTH, WORLD_SIZE } from '../core/constants';

const ROAD_WIDTH_HALF = ROAD_WIDTH / 2;

const CAB_COLOR = '#e8641b';
const BODY_COLOR = '#3c3f41';
const WHEEL_COLOR = '#1c1d1e';
const BEACON_COLOR = '#ffb020';

const BEACON_HZ = 2;

const POS_LAMBDA = 10;
const ROT_LAMBDA = 10;
const SLOPE_LAMBDA = 6; // pitch/roll damping toward terrain-derived tilt

const FADE_DURATION = 0.4; // seconds, easeOutCubic scale-in/out

// --- Arrivals/departures (Task 21 deliverable 4) ------------------------------------------
const SPAWN_DISTANCE = 60; // u away from the work front a vehicle spawns/departs to
const DRIVE_HANDOFF_DISTANCE = 120; // u; below this, drive between consecutive jobs; above, fade

const ROLLER_TRAIL_DISTANCE = 8;
const ROLLER_OSCILLATION_RANGE = 6; // ± units around the trail point
const ROLLER_OSCILLATION_SPEED = 3.2; // u/s along the oscillation path

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

// --- Excavator dig cycle -----------------------------------------------------------------
// Procedural (not literal-keyframed) ~4s cycle: dig at ground ahead -> lift -> yaw cab toward the
// truck side -> dump (tie into dust pool) -> swing back -> settle. Runs continuously while the
// excavator is actively grading/demolishing at the work front; if the vehicle relocates more than
// RELOCATE_THRESHOLD in a single frame (edge handoff / far target jump) the cycle pauses and the
// rig eases to a neutral "carry" pose instead of digging mid-teleport.
const DIG_CYCLE_DURATION = 4;
const DIG_PHASE = {
  approach: 0.18, // boom/stick reach down toward the ground
  dig: 0.32, // bucket curls, dust burst on contact
  lift: 0.48, // boom+stick lift, cab begins yawing toward dump side
  dump: 0.72, // cab reaches yaw target, bucket opens, dust burst on dump
  swingBack: 1.0, // cab yaws back, arm returns toward carry pose
} as const;
const CAB_YAW_AMOUNT = THREE.MathUtils.degToRad(60);
const RELOCATE_THRESHOLD = 1.5; // u/frame-equivalent distance that pauses the dig cycle
const RELOCATE_LAMBDA = 8; // settle-to-carry-pose damping while paused

// Carry pose (radians) the boom/stick/bucket ease toward while paused/relocating.
const CARRY_BOOM_Z = -0.3;
const CARRY_STICK_Z = 0.9;
const CARRY_BUCKET_Z = 0.4;

// --- Slope sampling ----------------------------------------------------------------------
const SLOPE_SAMPLE_LENGTHWISE = 1.4;
const SLOPE_SAMPLE_CROSSWISE = 0.9;
const MAX_TILT = THREE.MathUtils.degToRad(18); // clamp so steep terrain noise doesn't flip the rig

// --- Eased locomotion ----------------------------------------------------------------------
const SPEED_LAMBDA = 6; // how quickly the tracked "current speed" chases the raw per-frame speed
const ACCEL_PITCH_GAIN = 0.02; // radians of body pitch dip per unit of speed-change/dt
const MAX_ACCEL_PITCH = THREE.MathUtils.degToRad(6);

// --- Dump truck bed tipping ------------------------------------------------------------------
const BED_TIP_ANGLE = THREE.MathUtils.degToRad(35);
const BED_TIP_DURATION = 1.2; // seconds, eased up and back down
const BED_TIP_INTERVAL = 3; // seconds between tips while depositing gravel at the work front
const GRAVEL_COLOR = '#8a7960';

// --- Truck shuttle choreography (Task 21 deliverable 3) ---------------------------------------
const SPOIL_DUMPS_TO_FILL = 4; // dig-cycle dumps before the bed reads "full" and the truck departs
const SHUTTLE_AWAY_MIN = 8; // seconds
const SHUTTLE_AWAY_MAX = 12; // seconds
const SHUTTLE_ARRIVE_EPS = 1.5; // u; considered "arrived" within this distance of the target
const HEADING_FREEZE_EPS = 0.05; // u; below this, toGoal is too short/noisy to derive a heading from
const PAVED_DOCK_TIP_LAMBDA = 1 / 3; // very slow, gradual bed tip while docked at the paver hopper
const PAVED_DOCK_TIP_ANGLE = THREE.MathUtils.degToRad(12); // shallow — feeding the hopper, not dumping a full load

// --- Paver mat -------------------------------------------------------------------------------
const MAT_LENGTH = 3.5;
const MAT_FADE_TIME = 1.2; // seconds for the mat quad to fade as the real ribbon overtakes it
const MAT_COLOR = '#232323';

// --- Tire/track marks --------------------------------------------------------------------------
const TIRE_MARK_POOL_SIZE = 256;
const TIRE_MARK_FADE = 20; // seconds
const TIRE_MARK_INTERVAL = 0.25; // seconds between mark stamps per active vehicle
const TIRE_MARK_COLOR = '#2a2420';

// --- Floodlight ------------------------------------------------------------------------------
const FLOODLIGHT_EASE = 1.2; // seconds to ease in/out with night + job-active state
const FLOODLIGHT_COLOR = '#ffcf8a';

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

const WORLD_HALF = WORLD_SIZE / 2;

/** Direction (unit x/z) from `pos` toward the nearest of the four map edges — used both to spawn
 * arriving vehicles offscreen (Task 21 deliverable 4) and to send a "full" shuttle truck off to
 * dump out of view (deliverable 3). Picks whichever of +x/-x/+z/-z boundary is closest. */
function nearestEdgeDir(x: number, z: number): { x: number; z: number } {
  const distances: Array<[number, number, number]> = [
    [WORLD_HALF - x, 1, 0],
    [WORLD_HALF + x, -1, 0],
    [WORLD_HALF - z, 0, 1],
    [WORLD_HALF + z, 0, -1],
  ];
  distances.sort((a, b) => a[0] - b[0]);
  const [, dx, dz] = distances[0];
  return { x: dx, z: dz };
}

/** Whether the sample nearest arclength `t` along `samples` is a bridge-deck sample (mirrors
 * queue.ts's `nearestSampleIndex`, duplicated locally since that one isn't exported). Used to
 * decide whether a vehicle at `t` should align to terrain slope (ground) or stay flat (deck). */
function nearestSampleBridge(samples: { x: number; y: number; z: number; bridge: boolean }[], t: number): boolean {
  if (samples.length === 0) return false;
  let acc = 0;
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) {
      const a = samples[i - 1];
      const b = samples[i];
      acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const delta = Math.abs(acc - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return samples[bestIdx].bridge;
}

/** A rotating wheel/track mesh plus the radius used to convert linear travel into spin angle. */
interface WheelRef {
  mesh: THREE.Mesh;
  radius: number;
}

/** A vehicle's root group plus any named sub-parts that need per-frame animation. */
interface VehicleRig {
  kind: VehicleKind;
  group: THREE.Group;
  body: THREE.Group; // the part that pitches/rolls with slope + accel dip (everything but wheels, which stay grounded-looking via their own spin)
  beaconMat: THREE.MeshStandardMaterial;
  wheels: WheelRef[];
  materials: THREE.MeshStandardMaterial[];

  // excavator articulation only
  cab?: THREE.Group; // yaws toward the dump side during the dig cycle
  boom?: THREE.Group; // pivot 1 (shoulder)
  stick?: THREE.Group; // pivot 2 (elbow)
  bucket?: THREE.Group; // pivot 3 (wrist)
  trackTreadA?: THREE.Mesh; // alternating tread boxes for the "rolling track" illusion
  trackTreadB?: THREE.Mesh;

  // dump truck bed only
  bedPivot?: THREE.Group;
  spoilMesh?: THREE.Mesh; // spoil-mound lump that grows 0->1 as dig-cycle dumps land in the bed

  // paver mat only
  matMesh?: THREE.Mesh;
  matMat?: THREE.MeshStandardMaterial;
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
  const body = new THREE.Group(); // slope pitch/roll + accel dip applied here, wheels/tracks are children so they tilt with the chassis but spin independently
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  const treadMat = flatMat('#151515');
  materials.push(bodyMat, cabMat, wheelMat, treadMat);

  // tracked base
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.6, 1.8), wheelMat);
  base.position.y = 0.3;
  body.add(base);

  // Subtle "rolling track" illusion: two alternating tread boxes along each side of the base that
  // step forward/reset in a sawtooth, giving the impression of a moving tread without UV scroll
  // (plain MeshStandardMaterial has no texture to scroll). One box per phase, cross-faded so the
  // stepping reads as continuous motion rather than a pop.
  const treadGeo = new THREE.BoxGeometry(0.5, 0.12, 1.9);
  const trackTreadA = new THREE.Mesh(treadGeo, treadMat);
  trackTreadA.position.set(0.6, 0.62, 0);
  body.add(trackTreadA);
  const trackTreadB = new THREE.Mesh(treadGeo, treadMat);
  trackTreadB.position.set(-0.6, 0.62, 0);
  body.add(trackTreadB);

  // rotating cab (turret) — yaws toward the dump side during the dig cycle
  const cab = new THREE.Group();
  cab.position.y = 0.6;
  body.add(cab);

  const cabBody = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.5), cabMat);
  cabBody.position.set(-0.2, 0.45, 0);
  cab.add(cabBody);

  // Boom pivot (shoulder): sits at the front of the cab; boomArm mesh is offset so it extends
  // away from the pivot rather than rotating about its own center.
  const boom = new THREE.Group();
  boom.position.set(0.6, 0.7, 0);
  cab.add(boom);

  const boomArm = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 0.35), bodyMat);
  boomArm.position.set(1.0, 0, 0);
  boom.add(boomArm);

  // Stick pivot (elbow): positioned at the boom's far end, rotates independently of the boom.
  const stick = new THREE.Group();
  stick.position.set(2.0, 0, 0);
  boom.add(stick);

  const stickArm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.28), bodyMat);
  stickArm.position.set(0.7, 0, 0);
  stick.add(stickArm);

  // Bucket pivot (wrist): at the stick's far end.
  const bucket = new THREE.Group();
  bucket.position.set(1.4, 0, 0);
  stick.add(bucket);

  const bucketMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.6), bodyMat);
  bucketMesh.position.set(0.25, -0.25, 0);
  bucket.add(bucketMesh);

  const beaconMat = addBeacon(cab, 1.05);

  return {
    kind: 'excavator',
    group,
    body,
    beaconMat,
    wheels: [],
    materials,
    cab,
    boom,
    stick,
    bucket,
    trackTreadA,
    trackTreadB,
  };
}

function buildTruck(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  const gravelMat = flatMat(GRAVEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat, gravelMat);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.5), cabMat);
  cab.position.set(1.4, 0.85, 0);
  body.add(cab);

  // tipping bed pivot: hinge sits at the bed's rear-bottom edge so the bed rotates up and back,
  // dumping "out the tailgate" (-x, rear of the vehicle in local space).
  const bedPivot = new THREE.Group();
  bedPivot.position.set(-1.9, 0.45, 0);
  body.add(bedPivot);

  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 1.7), bodyMat);
  bed.position.set(1.3, 0.45, 0);
  bed.rotation.z = 0.05;
  bedPivot.add(bed);

  // Spoil mound: scales 0->1 in the bed as the excavator's dig cycle deposits loads (deliverable
  // 3). Parented to bedPivot so it tips out with the bed during the gravel-deposit animation.
  const spoilMesh = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.7, 8), gravelMat);
  spoilMesh.position.set(1.3, 0.95, 0);
  spoilMesh.scale.setScalar(0.001);
  bedPivot.add(spoilMesh);

  const wheelGeo = wheelCylinder(0.45, 1.9);
  const wheels: WheelRef[] = [];
  for (const x of [-1.3, 0, 1.4]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.45, 0);
    body.add(wheel);
    wheels.push({ mesh: wheel, radius: 0.45 });
  }

  const beaconMat = addBeacon(cab, 0.9);

  return { kind: 'truck', group, body, beaconMat, wheels, materials, bedPivot, spoilMesh };
}

function buildPaver(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  const matMat = new THREE.MeshStandardMaterial({
    color: MAT_COLOR,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0,
  });
  materials.push(bodyMat, cabMat, wheelMat, matMat);

  // low slab chassis
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.4, 1.9), bodyMat);
  slab.position.y = 0.3;
  body.add(slab);

  // hopper at the front (direction of travel is +x in local space)
  const hopper = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 1.8), bodyMat);
  hopper.position.set(1.2, 0.65, 0);
  body.add(hopper);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 1.1), cabMat);
  cab.position.set(-0.6, 0.75, 0);
  body.add(cab);

  const trackGeo = wheelCylinder(0.35, 1.7);
  const wheels: WheelRef[] = [];
  for (const x of [-1.1, 0.9]) {
    const track = new THREE.Mesh(trackGeo, wheelMat);
    track.position.set(x, 0.2, 0);
    body.add(track);
    wheels.push({ mesh: track, radius: 0.35 });
  }

  // Fresh-asphalt mat: a short glossy quad trailing the paver's rear, parented to `group` (not
  // `body`) so it stays screen-flat regardless of chassis pitch/roll — it represents freshly laid
  // material lying on the actual road surface, not a part of the vehicle body.
  const matGeo = new THREE.PlaneGeometry(MAT_LENGTH, 1.9);
  matGeo.rotateX(-Math.PI / 2);
  const matMesh = new THREE.Mesh(matGeo, matMat);
  matMesh.position.set(-1.8, 0.06, 0);
  group.add(matMesh);

  const beaconMat = addBeacon(cab, 0.5);

  return { kind: 'paver', group, body, beaconMat, wheels, materials, matMesh, matMat };
}

function buildRoller(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const drumMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, drumMat);

  // big front drum
  const drum = new THREE.Mesh(wheelCylinder(0.65, 1.8), drumMat);
  drum.position.set(1.1, 0.65, 0);
  body.add(drum);

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.3), bodyMat);
  chassis.position.set(-0.5, 0.75, 0);
  body.add(chassis);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 1.0), cabMat);
  cab.position.set(-0.8, 1.25, 0);
  body.add(cab);

  const rearWheelGeo = wheelCylinder(0.5, 1.6);
  const rearWheel = new THREE.Mesh(rearWheelGeo, drumMat);
  rearWheel.position.set(-1.3, 0.5, 0);
  body.add(rearWheel);

  const beaconMat = addBeacon(cab, 0.5);

  const wheels: WheelRef[] = [
    { mesh: drum, radius: 0.65 },
    { mesh: rearWheel, radius: 0.5 },
  ];

  return { kind: 'roller', group, body, beaconMat, wheels, materials };
}

function buildLiner(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(BODY_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  materials.push(bodyMat, cabMat, wheelMat);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.3), cabMat);
  cab.position.set(0.8, 0.7, 0);
  body.add(cab);

  const bed = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.3), bodyMat);
  bed.position.set(-0.5, 0.6, 0);
  body.add(bed);

  // rear nozzle assembly trailing behind (-x, toward the back of the vehicle)
  const nozzleArm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.15), bodyMat);
  nozzleArm.position.set(-1.4, 0.3, 0);
  body.add(nozzleArm);

  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), wheelMat);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(-1.7, 0.2, 0);
  body.add(nozzle);

  const wheelGeo = wheelCylinder(0.35, 1.4);
  const wheels: WheelRef[] = [];
  for (const x of [-0.8, 0.9]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(x, 0.35, 0);
    body.add(wheel);
    wheels.push({ mesh: wheel, radius: 0.35 });
  }

  const beaconMat = addBeacon(cab, 0.75);

  return { kind: 'liner', group, body, beaconMat, wheels, materials };
}

const SKIN_COLOR = '#c99a6f';
const HI_VIS_COLOR = '#d9d940';

/** Small tripod + figure rig for the survey phase — on foot, no wheels, walks the surveyed line
 * ahead of the excavator. Uses the same beacon slot as vehicles (required by VehicleRig) but at a
 * token size/intensity since a lone surveyor doesn't carry a beacon light in reality; kept for
 * interface consistency and cheap "is this rig alive" pulses elsewhere in the file. */
function buildSurveyor(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const skinMat = flatMat(SKIN_COLOR);
  const hiVisMat = flatMat(HI_VIS_COLOR);
  const tripodMat = flatMat(WHEEL_COLOR);
  materials.push(skinMat, hiVisMat, tripodMat);

  // tripod (total station) planted just ahead of the figure
  const tripod = new THREE.Group();
  tripod.position.set(0.8, 0, 0.3);
  body.add(tripod);
  for (const ang of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 5), tripodMat);
    leg.position.set(Math.cos(ang) * 0.18, 0.375, Math.sin(ang) * 0.18);
    leg.rotation.z = Math.cos(ang) * 0.35;
    leg.rotation.x = Math.sin(ang) * 0.35;
    tripod.add(leg);
  }
  const scope = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.16), tripodMat);
  scope.position.set(0, 0.82, 0);
  tripod.add(scope);

  // figure: legs, torso (hi-vis), head
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), tripodMat);
  legL.position.set(0, 0.3, 0.1);
  body.add(legL);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), tripodMat);
  legR.position.set(0, 0.3, -0.1);
  body.add(legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.24), hiVisMat);
  torso.position.set(0, 0.85, 0);
  body.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), skinMat);
  head.position.set(0, 1.28, 0);
  body.add(head);

  // arm reaching toward the tripod's scope
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1), skinMat);
  arm.position.set(0.25, 0.95, 0.15);
  arm.rotation.z = -0.2;
  body.add(arm);

  const beaconMat = addBeacon(body, 1.5);
  beaconMat.emissiveIntensity = 0;

  return { kind: 'surveyor', group, body, beaconMat, wheels: [], materials };
}

/**
 * Minimal placeholder rig for 'crane' (Task 22's bridge-construction vehicle kind, added to
 * VehicleKind now per Addendum A so this file's Record<VehicleKind, VehicleRig> type-checks).
 * Never targeted by any `construction:progress` event yet — queue.ts doesn't emit it — so this
 * stays permanently hidden/unused until Task 22 builds it out properly. Kept intentionally tiny.
 */
function buildCrane(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const bodyMat = flatMat(BODY_COLOR);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), bodyMat);
  base.position.y = 0.25;
  body.add(base);
  const beaconMat = addBeacon(body, 1.0);
  return { kind: 'crane', group, body, beaconMat, wheels: [], materials: [bodyMat] };
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
  // Edge-session tracking so a same-kind vehicle handed from one edge's job to another's (e.g. a
  // demolish job on edge A immediately followed by a queued build job on edge B, both using the
  // excavator) doesn't glide/teleport across the gap. `currentEdgeId` is the edge this vehicle is
  // currently "shown" on; a progress event for a different edge is buffered in `pendingHandoff`
  // rather than applied immediately, and `handoffPending` forces a fade-out (ignoring the normal
  // idle-timeout liveness check) until the vehicle is fully hidden, at which point update() snaps
  // it to the buffered position/heading and lets it fade back in.
  currentEdgeId: number | null;
  handoffPending: boolean;
  pendingPos: THREE.Vector3;
  pendingHeading: number;
  pendingEdgeId: number | null;

  // --- Task 20 additions ---
  prevPos: THREE.Vector3; // curPos as of last frame, for displacement-based wheel spin + speed
  curSpeed: number; // damped scalar speed (u/s), chases raw per-frame displacement/dt
  prevSpeed: number; // curSpeed as of last frame, for accel-sign body pitch dip
  bodyPitchDip: number; // current eased accel/brake pitch dip (radians), separate from slope tilt
  slopePitch: number; // damped terrain-slope pitch (radians)
  slopeRoll: number; // damped terrain-slope roll (radians)
  onBridge: boolean; // latest progress event's nearest-sample bridge flag (skip slope alignment)
  stage: string; // latest reported stage, used to gate tire marks / bed tipping / roller mode
  demolish: boolean;
  tireMarkTimer: number;

  // excavator dig-cycle
  digPhase: number; // 0..DIG_CYCLE_DURATION, loops while working
  digPaused: boolean; // true while the vehicle relocated more than RELOCATE_THRESHOLD this frame

  // dump truck bed tipping
  bedTipTimer: number; // counts up toward BED_TIP_INTERVAL while depositing at the work front
  bedTipElapsed: number; // 0..BED_TIP_DURATION*2 (up then back down), 0 when resting
  bedTipAngle: number; // current eased tip angle

  // roller oscillation
  rollerOscOffset: number; // signed distance along the path from the trail point, -RANGE..+RANGE
  rollerOscDir: number; // +1 or -1

  // --- Task 21 additions ---
  // Arrivals/departures (deliverable 4): on a fresh sighting (or a same-kind handoff to a nearby
  // job), the vehicle is placed at a point offscreen and let the existing position damp carry it
  // in, reading as "driving to the site" rather than fading in at the work front. `justSpawned`
  // guards against re-triggering the spawn placement on every progress event for the same session.
  justSpawned: boolean;

  // Truck shuttle choreography (deliverable 3, render-only theater — sim timing is untouched):
  // the truck idles beside the excavator during graded work, filling its bed a bit each dig-cycle
  // dump; once "full" it drives off to the nearest map edge, pauses offscreen, then returns empty.
  // `shuttlePhase` is purely cosmetic and never affects when construction:progress fires.
  shuttlePhase: 'idle' | 'departing' | 'away' | 'returning';
  spoilLevel: number; // 0..1, grows one step per dig-cycle dump, drives spoilMesh scale
  shuttleTimer: number; // seconds elapsed in the current phase
  shuttleAwayDuration: number; // randomized 8-12s "away" hold, rolled fresh each departure
  shuttleReturnPos: THREE.Vector3; // work-front position to return to (captured at departure time)
  shuttleAwayPos: THREE.Vector3; // offscreen point the truck drives to when full
  dumpCountThisLoad: number; // dig-cycle dumps received since the bed was last emptied
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

const markDummy = new THREE.Object3D();

/**
 * Fixed-capacity instanced pool of fading tire/track-mark decals (flat quads, one InstancedMesh —
 * one draw call regardless of how many marks are alive). `stamp()` overwrites the oldest slot
 * ring-buffer style; `update()` fades each live mark by shrinking its scale toward 0 over
 * `TIRE_MARK_FADE` seconds (cheaper than per-instance opacity, which InstancedMesh doesn't support
 * without a custom shader) — visually reads as the mark sinking into the dirt / weathering away.
 */
class TireMarkPool {
  private readonly capacity: number;
  private readonly ages: Float32Array;
  private readonly alive: Uint8Array;
  private readonly baseScaleX: Float32Array;
  private readonly baseScaleZ: Float32Array;
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly heading: Float32Array;
  private cursor = 0;
  readonly mesh: THREE.InstancedMesh;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ages = new Float32Array(capacity).fill(Infinity);
    this.alive = new Uint8Array(capacity);
    this.baseScaleX = new Float32Array(capacity);
    this.baseScaleZ = new Float32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: TIRE_MARK_COLOR,
      roughness: 1,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // start every slot's matrix parked far below the world so a not-yet-stamped slot never shows
    for (let i = 0; i < capacity; i++) {
      markDummy.position.set(0, -9999, 0);
      markDummy.updateMatrix();
      this.mesh.setMatrixAt(i, markDummy.matrix);
    }
  }

  /** Stamps a new mark at (x,y,z) with the given heading (radians) and footprint size. */
  stamp(x: number, y: number, z: number, heading: number, width: number, length: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.ages[i] = 0;
    this.alive[i] = 1;
    this.baseScaleX[i] = width;
    this.baseScaleZ[i] = length;
    this.posX[i] = x;
    this.posY[i] = y + 0.02;
    this.posZ[i] = z;
    this.heading[i] = heading;

    markDummy.position.set(x, y + 0.02, z);
    markDummy.rotation.set(0, -heading, 0);
    markDummy.scale.set(width, 1, length);
    markDummy.updateMatrix();
    this.mesh.setMatrixAt(i, markDummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = Math.min(this.capacity, Math.max(this.mesh.count, i + 1));
  }

  update(dt: number): void {
    let touched = false;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.ages[i] += dt;
      const life = clamp01(this.ages[i] / TIRE_MARK_FADE);
      if (life >= 1) {
        this.alive[i] = 0;
        markDummy.position.set(0, -9999, 0);
        markDummy.rotation.set(0, 0, 0);
        markDummy.scale.set(1, 1, 1);
        markDummy.updateMatrix();
        this.mesh.setMatrixAt(i, markDummy.matrix);
        touched = true;
        continue;
      }
      // fade by shrinking scale toward 0 (eased) rather than per-instance opacity
      const fade = 1 - easeOutCubic(life);
      markDummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
      markDummy.rotation.set(0, -this.heading[i], 0);
      markDummy.scale.set(this.baseScaleX[i] * fade, 1, this.baseScaleZ[i] * fade);
      markDummy.updateMatrix();
      this.mesh.setMatrixAt(i, markDummy.matrix);
      touched = true;
    }
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const stakeDummy = new THREE.Object3D();

/**
 * Fixed-capacity instanced pool of survey stakes (Task 21 deliverable 2): `plant()` places a stake
 * at a given arclength `t` along an edge (rounded to the nearest STAKE_SPACING bucket so repeated
 * calls as the surveyor walks past don't re-stamp the same spot), eased in via a quick scale-up.
 * `removeNear(edgeId, t)` eases a planted stake back out (used when grading later passes over it —
 * "removed progressively as grading passes"). One InstancedMesh, one draw call regardless of count.
 */
const STAKE_SPACING = 4; // u between planted stakes along the surveyed line
const STAKE_EASE = 0.35; // seconds to scale a stake in/out
const STAKE_POOL_SIZE = 96; // plenty for several concurrent/recent surveyed edges

class StakePool {
  private readonly capacity: number;
  private readonly alive: Uint8Array;
  private readonly scale: Float32Array; // current eased 0..1
  private readonly targetScale: Float32Array;
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly edgeId: Int32Array;
  private readonly bucket: Int32Array; // rounded arclength bucket, for dedupe + removeNear matching
  private cursor = 0;
  readonly mesh: THREE.InstancedMesh;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.scale = new Float32Array(capacity);
    this.targetScale = new Float32Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.edgeId = new Int32Array(capacity).fill(-1);
    this.bucket = new Int32Array(capacity).fill(-1);

    const geo = new THREE.CylinderGeometry(0.1, 0.1, 0.9, 6);
    geo.translate(0, 0.45, 0);
    const mat = flatMat('#e8641b');
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      stakeDummy.position.set(0, -9999, 0);
      stakeDummy.scale.setScalar(0.001);
      stakeDummy.updateMatrix();
      this.mesh.setMatrixAt(i, stakeDummy.matrix);
    }
  }

  /** Plants a stake at (x,y,z) for `edgeId` at arclength `t`, deduped to one per STAKE_SPACING
   * bucket so a slow-moving surveyor doesn't spam the pool. No-op if that bucket already has a
   * live (or fading-in) stake. */
  plant(edgeId: number, t: number, x: number, y: number, z: number): void {
    const bucket = Math.round(t / STAKE_SPACING);
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.edgeId[i] === edgeId && this.bucket[i] === bucket) return; // already planted
    }
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.alive[i] = 1;
    this.scale[i] = 0;
    this.targetScale[i] = 1;
    this.posX[i] = x;
    this.posY[i] = y;
    this.posZ[i] = z;
    this.edgeId[i] = edgeId;
    this.bucket[i] = bucket;
  }

  /** Eases out (and eventually frees) every stake on `edgeId` at or behind arclength `t` — used
   * when grading overtakes the surveyed line and the stakes there are no longer needed. */
  removeBehind(edgeId: number, t: number): void {
    const thresholdBucket = Math.floor(t / STAKE_SPACING);
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.edgeId[i] === edgeId && this.bucket[i] <= thresholdBucket) {
        this.targetScale[i] = 0;
      }
    }
  }

  /** Eases out every stake belonging to `edgeId` (job ended before grading swept them all). */
  removeAll(edgeId: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] && this.edgeId[i] === edgeId) this.targetScale[i] = 0;
    }
  }

  update(dt: number): void {
    let touched = false;
    const rate = dt / STAKE_EASE;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const goal = this.targetScale[i];
      if (this.scale[i] < goal) this.scale[i] = Math.min(goal, this.scale[i] + rate);
      else if (this.scale[i] > goal) this.scale[i] = Math.max(goal, this.scale[i] - rate);
      if (goal === 0 && this.scale[i] <= 0.001) {
        this.alive[i] = 0;
        this.edgeId[i] = -1;
        this.bucket[i] = -1;
        stakeDummy.position.set(0, -9999, 0);
        stakeDummy.scale.setScalar(0.001);
        stakeDummy.updateMatrix();
        this.mesh.setMatrixAt(i, stakeDummy.matrix);
        touched = true;
        continue;
      }
      stakeDummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
      stakeDummy.scale.set(1, Math.max(0.001, this.scale[i]), 1);
      stakeDummy.updateMatrix();
      this.mesh.setMatrixAt(i, stakeDummy.matrix);
      touched = true;
    }
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const coneDummy = new THREE.Object3D();
const CONE_COUNT = 6; // fixed instance count: 3 either side of the active work front (must stay even — ConePool splits it in half per side)
const CONE_OFFSET = 10; // ± units from the work front, per spec
const CONE_LAMBDA = 6; // position damping as the front advances

/** Instanced traffic cones bracketing the active work front (site dressing, Task 21 deliverable
 * 5): a fixed CONE_COUNT set of instances is repositioned each frame (damped) to sit in a small
 * cluster ±CONE_OFFSET ahead/behind the current work-front position, easing to scale 0 when no job
 * is active. One InstancedMesh — one draw call regardless of instance count. */
class ConePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly curX: Float32Array;
  private readonly curY: Float32Array;
  private readonly curZ: Float32Array;
  private initialized = false;
  private visibility = 0; // eased 0..1

  constructor() {
    const geo = new THREE.ConeGeometry(0.28, 0.6, 8);
    geo.translate(0, 0.3, 0);
    const mat = flatMat('#e8641b', '#5a2200');
    this.mesh = new THREE.InstancedMesh(geo, mat, CONE_COUNT);
    this.mesh.count = CONE_COUNT;
    this.mesh.frustumCulled = false;
    this.curX = new Float32Array(CONE_COUNT);
    this.curY = new Float32Array(CONE_COUNT);
    this.curZ = new Float32Array(CONE_COUNT);
  }

  /** `active` = a job is currently in progress somewhere; `pos`/`heading` = the current work
   * front. Cones cluster in two rows of three either side of the road, offset along the direction
   * of travel so they read as bracketing the work rather than sitting on the vehicle's path. */
  update(dt: number, active: boolean, pos: THREE.Vector3, heading: number): void {
    this.visibility = damp(this.visibility, active ? 1 : 0, 1 / FADE_DURATION, dt);
    const scale = easeOutCubic(clamp01(this.visibility));
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const perpX = -sinH;
    const perpZ = cosH;
    const half = CONE_COUNT / 2;

    for (let i = 0; i < CONE_COUNT; i++) {
      const side = i < half ? -1 : 1;
      const along = (i % half) - (half - 1) / 2; // -1, 0, 1 for 3-per-side
      const targetX = pos.x + perpX * side * (ROAD_WIDTH_HALF + 1.5) + cosH * along * CONE_OFFSET * 0.6;
      const targetZ = pos.z + perpZ * side * (ROAD_WIDTH_HALF + 1.5) + sinH * along * CONE_OFFSET * 0.6;
      const targetY = pos.y;
      if (!this.initialized) {
        this.curX[i] = targetX;
        this.curY[i] = targetY;
        this.curZ[i] = targetZ;
      } else {
        this.curX[i] = damp(this.curX[i], targetX, CONE_LAMBDA, dt);
        this.curY[i] = damp(this.curY[i], targetY, CONE_LAMBDA, dt);
        this.curZ[i] = damp(this.curZ[i], targetZ, CONE_LAMBDA, dt);
      }

      coneDummy.position.set(this.curX[i], this.curY[i], this.curZ[i]);
      coneDummy.scale.setScalar(Math.max(0.001, scale));
      coneDummy.updateMatrix();
      this.mesh.setMatrixAt(i, coneDummy.matrix);
    }
    this.initialized = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = scale > 0.001;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** A material stockpile prop (site dressing, Task 21 deliverable 5): a gravel mound + a small
 * pallet stack, ≤6 primitives total. Lives at a job's start point for the job's duration and fades
 * out on completion (opacity + scale, driven by `visibility` in the renderer's update loop). */
interface StockpileRig {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
}

function buildStockpile(): StockpileRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const gravelMat = flatMat(GRAVEL_COLOR);
  const palletMat = flatMat('#a9812f');
  const wrapMat = flatMat('#d8d0b0');
  materials.push(gravelMat, palletMat, wrapMat);

  const mound = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.3, 10), gravelMat);
  mound.position.set(0, 0.65, 0);
  group.add(mound);

  const mound2 = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.8, 8), gravelMat);
  mound2.position.set(1.6, 0.4, 0.6);
  group.add(mound2);

  // pallet stack: two crates on a base slab
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 1.1), palletMat);
  base.position.set(-2.2, 0.075, -0.4);
  group.add(base);

  const crateA = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.9), wrapMat);
  crateA.position.set(-2.2, 0.45, -0.4);
  group.add(crateA);

  const crateB = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.7), wrapMat);
  crateB.position.set(-2.15, 0.95, -0.35);
  group.add(crateB);

  return { group, materials };
}

/** A single floodlight-tower prop: a pole + emissive head + one THREE.SpotLight (budgeted). */
interface FloodlightRig {
  group: THREE.Group;
  light: THREE.SpotLight;
  headMat: THREE.MeshStandardMaterial;
  poleMat: THREE.MeshStandardMaterial;
}

function buildFloodlight(scene: THREE.Scene): FloodlightRig {
  const group = new THREE.Group();
  const poleMat = flatMat('#4a4a4a');
  const headMat = flatMat('#e8e8e0', FLOODLIGHT_COLOR);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 6, 8), poleMat);
  pole.position.y = 3;
  group.add(pole);

  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.5), headMat);
  head.position.set(0.3, 6.1, 0);
  head.rotation.z = -0.35;
  group.add(head);

  // Single budgeted SpotLight, shadowless (Zen perf constraint — no extra shadow-map draw calls).
  const light = new THREE.SpotLight(FLOODLIGHT_COLOR, 0, 40, THREE.MathUtils.degToRad(35), 0.4, 1.2);
  light.castShadow = false;
  light.position.set(0.3, 6.1, 0);
  const target = new THREE.Object3D();
  target.position.set(4, 0, 0);
  group.add(target);
  light.target = target;
  group.add(light);

  group.visible = false;
  scene.add(group);

  return { group, light, headMat, poleMat };
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
  private gravelPool: ParticlePool;
  private tireMarks: TireMarkPool;
  private stakes: StakePool;
  private cones: ConePool;
  private stockpile: StockpileRig;
  private stockpileVisibility = 0; // eased 0..1
  private stockpileEdgeId: number | null = null; // which job's start point the stockpile currently marks
  private dustTimer = 0;
  private steamTimer = 0;

  private floodlight: FloodlightRig;
  private floodlightVisibility = 0; // eased 0..1, drives light intensity + head emissive

  private clock = 0;
  // last-seen progress event per non-roller vehicle kind, used to detect "job stopped this frame"
  private lastSeenAt: Map<VehicleKind, number> = new Map();
  private lastRollerSeenAt = -Infinity;
  private readonly IDLE_TIMEOUT = 0.2; // seconds without a progress event => job considered done

  constructor(
    private scene: THREE.Scene,
    bus: EventBus,
    private graph: RoadGraph,
    private hf: Heightfield,
  ) {
    this.rigs = {
      excavator: buildExcavator(),
      truck: buildTruck(),
      paver: buildPaver(),
      roller: buildRoller(),
      liner: buildLiner(),
      surveyor: buildSurveyor(),
      crane: buildCrane(),
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
    this.gravelPool = new ParticlePool(80, 1.0, GRAVEL_COLOR, 0.9);
    this.tireMarks = new TireMarkPool(TIRE_MARK_POOL_SIZE);
    this.stakes = new StakePool(STAKE_POOL_SIZE);
    this.cones = new ConePool();
    this.stockpile = buildStockpile();
    this.stockpile.group.visible = false;
    this.stockpile.group.scale.setScalar(0.001);
    this.scene.add(this.dustPool.points);
    this.scene.add(this.steamPool.points);
    this.scene.add(this.gravelPool.points);
    this.scene.add(this.tireMarks.mesh);
    this.scene.add(this.stakes.mesh);
    this.scene.add(this.cones.mesh);
    this.scene.add(this.stockpile.group);

    this.floodlight = buildFloodlight(this.scene);

    bus.on('construction:progress', (e) => this.onProgress(e));
    // Safety net for stakes: grading normally sweeps every planted stake away as the work front
    // passes (see onProgress's `stakes.removeBehind` call), but a demolish job walking an edge
    // back down to 'removed' — or a bridge run where grading skips flattening on deck samples —
    // could otherwise leave stray stakes behind forever. Any terminal stage transition for an
    // edge clears whatever's left for it.
    bus.on('construction:stage', (e) => {
      if (e.stage === 'painted' || e.stage === 'removed') this.stakes.removeAll(e.edgeId);
    });
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
      currentEdgeId: null,
      handoffPending: false,
      pendingPos: new THREE.Vector3(),
      pendingHeading: 0,
      pendingEdgeId: null,
      prevPos: new THREE.Vector3(),
      curSpeed: 0,
      prevSpeed: 0,
      bodyPitchDip: 0,
      slopePitch: 0,
      slopeRoll: 0,
      onBridge: false,
      stage: 'graded',
      demolish: false,
      tireMarkTimer: 0,
      digPhase: 0,
      digPaused: false,
      bedTipTimer: 0,
      bedTipElapsed: 0,
      bedTipAngle: 0,
      rollerOscOffset: 0,
      rollerOscDir: 1,
      justSpawned: false,
      shuttlePhase: 'idle',
      spoilLevel: 0,
      shuttleTimer: 0,
      shuttleAwayDuration: 10,
      shuttleReturnPos: new THREE.Vector3(),
      shuttleAwayPos: new THREE.Vector3(),
      dumpCountThisLoad: 0,
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

  /**
   * Applies a newly-reported position/heading for `edgeId` to `state`, session-aware: if this is
   * the same edge the vehicle is already showing (or its first sighting ever), the target is
   * applied directly and damping/fade behaves exactly as before. If it's a *different* edge (a
   * same-kind job handoff, e.g. demolish-excavator on edge A immediately followed by a queued
   * build-excavator on edge B), the new position is buffered rather than applied — the vehicle
   * keeps damping toward its *old* target and is forced to fade out (see `handoffPending` in
   * `stepVehicle`); once fully hidden, `update()` snaps it onto the buffered target and lets it
   * fade back in on the new edge.
   */
  private applyProgressTarget(state: VehicleState, edgeId: number, pos: THREE.Vector3, heading: number): void {
    if (!state.hasTarget) {
      // Arrivals (deliverable 4): place the vehicle SPAWN_DISTANCE away toward the nearest map
      // edge and let normal position damping carry it in, reading as "driving to the job" rather
      // than fading in already-on-site. Degenerate spawn geometry (nearest-edge direction points
      // back through the position itself, e.g. dead-center of an oddly-shaped world) can't really
      // happen given nearestEdgeDir always returns a unit vector, but as a defensive fallback if
      // the computed spawn point is somehow non-finite, snap directly (old fade-in-place behavior).
      const dir = nearestEdgeDir(pos.x, pos.z);
      const spawnX = pos.x + dir.x * SPAWN_DISTANCE;
      const spawnZ = pos.z + dir.z * SPAWN_DISTANCE;
      const spawnValid = Number.isFinite(spawnX) && Number.isFinite(spawnZ);
      state.targetPos.copy(pos);
      state.targetHeading = heading;
      if (spawnValid) {
        state.curPos.set(spawnX, pos.y, spawnZ);
        state.curHeading = Math.atan2(pos.z - spawnZ, pos.x - spawnX);
      } else {
        state.curPos.copy(pos);
        state.curHeading = heading;
      }
      state.hasTarget = true;
      state.currentEdgeId = edgeId;
      return;
    }

    if (state.currentEdgeId === null || state.currentEdgeId === edgeId) {
      // same session (or a state that was never assigned an edge, e.g. legacy/edge-less) — behave
      // exactly as before.
      state.currentEdgeId = edgeId;
      state.targetPos.copy(pos);
      state.targetHeading = heading;
      return;
    }

    // Different edge (a same-kind job handoff): if the new job's start is close to where the
    // vehicle currently is, drive it over directly (just retarget — the existing damped motion
    // reads as driving from the old site to the new one). Otherwise it's too far to plausibly
    // drive in view, so fall back to the fade-out/relocate/fade-in handoff as before.
    const dist = state.curPos.distanceTo(pos);
    if (dist < DRIVE_HANDOFF_DISTANCE) {
      state.currentEdgeId = edgeId;
      state.targetPos.copy(pos);
      state.targetHeading = heading;
      return;
    }

    // Different edge, far apart: buffer the target and request a fade-out; do NOT touch
    // targetPos/Heading so the vehicle keeps damping toward its last on-screen position while it
    // fades. Once fully faded (see stepVehicle), it's relocated near the new job's start and eases
    // back in via the same spawn-and-drive-in path as a fresh sighting.
    state.handoffPending = true;
    state.pendingPos.copy(pos);
    state.pendingHeading = heading;
    state.pendingEdgeId = edgeId;
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
    this.applyProgressTarget(state, e.edgeId, new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), e.heading);
    this.lastSeenAt.set(e.vehicle, this.clock);
    state.stage = e.stage;
    state.demolish = e.demolish;

    const edge = this.graph.edges.get(e.edgeId);
    state.onBridge = edge ? nearestSampleBridge(edge.samples, e.t) : false;

    // Dust/steam bursts are driven by timers in update() (see there), not per-event — progress
    // events fire at 60/s and would otherwise blow through the particle pool in a fraction of a
    // second. This handler only tracks liveness + (for 'paved') the trailing roller's target.

    // Site dressing (deliverable 5): a fixed stockpile prop marks the job's start point for the
    // job's whole duration (any stage, any vehicle) — captured once per edge and held until a
    // different edge's job takes over or the job goes idle (handled in update()'s fade logic).
    if (edge && this.stockpileEdgeId !== e.edgeId) {
      this.stockpileEdgeId = e.edgeId;
      const start = edge.samples[0];
      this.stockpile.group.position.set(start.x, start.y, start.z);
      this.stockpile.group.rotation.y = -e.heading;
    }

    // Survey stakes (deliverable 2): the surveyor plants a real stake every STAKE_SPACING as it
    // passes; grading later sweeps them away as the work front overtakes the surveyed line.
    if (e.vehicle === 'surveyor' && edge) {
      const y = this.hf.heightAt(e.pos.x, e.pos.z);
      this.stakes.plant(e.edgeId, e.t, e.pos.x, y, e.pos.z);
    }
    if (e.stage === 'graded' && !e.demolish) {
      this.stakes.removeBehind(e.edgeId, e.t);
    }

    if (e.stage === 'paved' && edge) {
      // Roller now performs visible back-and-forth passes around the trail point rather than
      // pure trailing — the base trail point (work front minus ROLLER_TRAIL_DISTANCE) is still
      // computed here as the center of the oscillation; update() applies the ± offset each frame.
      const rollerT = Math.max(0, e.t - ROLLER_TRAIL_DISTANCE);
      const { pos, heading } = sampleAt(edge.samples, rollerT);
      const rollerHeading = e.demolish ? heading + Math.PI : heading;
      this.applyProgressTarget(this.roller, e.edgeId, new THREE.Vector3(pos.x, pos.y, pos.z), rollerHeading);
      this.lastRollerSeenAt = this.clock;
      this.roller.stage = 'paved';
      this.roller.demolish = e.demolish;
      this.roller.onBridge = nearestSampleBridge(edge.samples, rollerT);
    }

    // Truck shuttle theater (deliverable 3): during 'graded' and 'paved' stages queue.ts never
    // reports a `vehicle: 'truck'` progress event (only 'gravel' does), so the truck's presence
    // then is purely synthesized here from the excavator's/paver's own progress — exactly the
    // same synthesis pattern used for the roller above. Sim timing (job.t/stage transitions) is
    // completely untouched; this only ever feeds the truck's *cosmetic* target position.
    if (e.stage === 'graded' && !e.demolish && edge) {
      const truckState = this.stateFor('truck');
      // idle a short distance behind the excavator, off to the dump side, facing back toward it
      const perpX = -Math.sin(e.heading);
      const perpZ = Math.cos(e.heading);
      const behind = 6;
      const side = 3.5;
      const tx = e.pos.x - Math.cos(e.heading) * behind + perpX * side;
      const tz = e.pos.z - Math.sin(e.heading) * behind + perpZ * side;
      const ty = this.hf.heightAt(tx, tz);
      const truckHeading = e.heading + Math.PI * 0.5;
      // The truck stays "alive" (not idle-timed-out) for the whole graded job regardless of
      // shuttle phase — only its idle-anchor *position* is gated on shuttlePhase === 'idle';
      // while departing/away/returning, updateTruckShuttle drives targetPos/targetHeading instead.
      this.lastSeenAt.set('truck', this.clock);
      if (truckState.shuttlePhase === 'idle') {
        this.applyProgressTarget(truckState, e.edgeId, new THREE.Vector3(tx, ty, tz), truckHeading);
      } else {
        truckState.currentEdgeId = e.edgeId;
      }
      truckState.stage = 'graded';
      truckState.demolish = false;
      truckState.onBridge = nearestSampleBridge(edge.samples, e.t);
      truckState.shuttleReturnPos.set(tx, ty, tz);
    } else if (e.stage === 'paved' && !e.demolish && edge) {
      const truckState = this.stateFor('truck');
      // dock nose-to-hopper just behind the paver (paver travel direction is +heading, hopper is
      // at its front, so the truck backs up to it from behind).
      const dockDist = 3.2;
      const tx = e.pos.x - Math.cos(e.heading) * dockDist;
      const tz = e.pos.z - Math.sin(e.heading) * dockDist;
      const ty = this.hf.heightAt(tx, tz);
      this.applyProgressTarget(truckState, e.edgeId, new THREE.Vector3(tx, ty, tz), e.heading);
      this.lastSeenAt.set('truck', this.clock);
      truckState.stage = 'paved';
      truckState.demolish = false;
      truckState.onBridge = nearestSampleBridge(edge.samples, e.t);
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

  /**
   * Damps position/heading toward the last-reported target, advances fade scale toward `active`,
   * and applies the result to the rig's THREE.Group. If a same-kind edge handoff is pending (see
   * `applyProgressTarget`), `active` is overridden to force a fade-out; once the fade-out
   * completes (scale reaches ~0), the vehicle is snapped onto the buffered handoff target and
   * allowed to fade back in from there — so a handoff never damps/glides across the gap between
   * the old edge and the new one.
   *
   * Task 20 additions, all derived from this same damped motion (no sim changes needed): wheel
   * spin proportional to actual per-frame displacement, body pitch/roll aligned to terrain slope
   * (or flat on a bridge deck), and a small accel/brake pitch dip driven by the eased "current
   * speed" chasing the raw displacement/dt.
   */
  private stepVehicle(state: VehicleState, dt: number, active: boolean): void {
    if (!state.hasTarget) return;

    state.prevPos.copy(state.curPos);

    // The shuttling truck fades out for its 'away' hold (dumps off-map "just fades at distance",
    // per spec) even though it's still linked to an active graded job (lastSeenAt keeps updating,
    // see onProgress) — handoffPending already overrides `active` the same way for the same
    // reason (visually hidden without being considered "job stopped").
    const effectiveActive = state.handoffPending || state.shuttlePhase === 'away' ? false : active;

    state.curPos.x = damp(state.curPos.x, state.targetPos.x, POS_LAMBDA, dt);
    state.curPos.y = damp(state.curPos.y, state.targetPos.y, POS_LAMBDA, dt);
    state.curPos.z = damp(state.curPos.z, state.targetPos.z, POS_LAMBDA, dt);

    // shortest-path angle damping
    let delta = state.targetHeading - state.curHeading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    state.curHeading = state.curHeading + delta * (1 - Math.exp(-ROT_LAMBDA * dt));

    const direction = effectiveActive ? 1 : -1;
    state.fadeElapsed = clamp01(state.fadeElapsed + direction * (dt / FADE_DURATION));
    // `fadeElapsed` always represents "progress toward fully shown" (1 = fully visible, 0 = fully
    // hidden); ease it so scale-in/out both use easeOutCubic rather than linear interpolation.
    state.scale = easeOutCubic(state.fadeElapsed);

    if (state.handoffPending && state.fadeElapsed <= 0.001) {
      // Fully faded out — this handoff was far enough (>= DRIVE_HANDOFF_DISTANCE) that driving
      // over wasn't plausible, so relocate offscreen near the new job (same spawn geometry as a
      // fresh arrival) and let it drive+fade back in from there rather than snapping directly onto
      // the work front.
      const dir = nearestEdgeDir(state.pendingPos.x, state.pendingPos.z);
      const spawnX = state.pendingPos.x + dir.x * SPAWN_DISTANCE;
      const spawnZ = state.pendingPos.z + dir.z * SPAWN_DISTANCE;
      const spawnValid = Number.isFinite(spawnX) && Number.isFinite(spawnZ);
      if (spawnValid) {
        state.curPos.set(spawnX, state.pendingPos.y, spawnZ);
        state.curHeading = Math.atan2(state.pendingPos.z - spawnZ, state.pendingPos.x - spawnX);
      } else {
        state.curPos.copy(state.pendingPos);
        state.curHeading = state.pendingHeading;
      }
      state.targetPos.copy(state.pendingPos);
      state.targetHeading = state.pendingHeading;
      state.currentEdgeId = state.pendingEdgeId;
      state.handoffPending = false;
      state.pendingEdgeId = null;
      state.prevPos.copy(state.curPos); // no spurious displacement on the handoff snap
    }

    const rig = state.rig;
    rig.group.visible = state.scale > 0.001;
    rig.group.position.copy(state.curPos);
    rig.group.rotation.y = -state.curHeading;
    rig.group.scale.setScalar(Math.max(0.001, state.scale));

    // --- Eased locomotion: track actual per-frame displacement as "speed", damp it, and derive a
    // small forward/backward body pitch dip from its rate of change (accelerating dips the nose
    // up slightly, braking dips it down) — this reads as acceleration/deceleration shaping rather
    // than a constant-velocity glide, without touching the underlying damped position itself. ---
    const dist = dt > 0 ? state.curPos.distanceTo(state.prevPos) : 0;
    const rawSpeed = dt > 0 ? dist / dt : 0;
    state.prevSpeed = state.curSpeed;
    state.curSpeed = damp(state.curSpeed, rawSpeed, SPEED_LAMBDA, dt);
    const speedDelta = dt > 0 ? (state.curSpeed - state.prevSpeed) / dt : 0;
    const targetPitchDip = clamp01(Math.abs(speedDelta) * ACCEL_PITCH_GAIN) * Math.sign(speedDelta) * -1;
    state.bodyPitchDip = damp(state.bodyPitchDip, THREE.MathUtils.clamp(targetPitchDip, -MAX_ACCEL_PITCH, MAX_ACCEL_PITCH), SPEED_LAMBDA, dt);

    // --- Wheel/track rotation: spin every wheel by (distance traveled / radius) radians, so
    // rolling speed always matches actual displacement rather than a fixed animation rate. ---
    if (dist > 0.00001 && rig.wheels.length > 0) {
      for (const w of rig.wheels) {
        w.mesh.rotation.x += dist / w.radius;
      }
    }

    // --- Slope alignment: sample terrain height at small lengthwise/crosswise offsets around the
    // vehicle's current position to estimate the local surface normal, then derive pitch (forward
    // tilt) and roll (side tilt) from it, damped so the chassis never snaps. Bridges stay flat
    // (aligned to the deck, not the terrain below). ---
    let targetPitch = 0;
    let targetRoll = 0;
    if (!state.onBridge) {
      const cosH = Math.cos(state.curHeading);
      const sinH = Math.sin(state.curHeading);
      const x = state.curPos.x, z = state.curPos.z;
      const hFwd = this.hf.heightAt(x + cosH * SLOPE_SAMPLE_LENGTHWISE, z + sinH * SLOPE_SAMPLE_LENGTHWISE);
      const hBack = this.hf.heightAt(x - cosH * SLOPE_SAMPLE_LENGTHWISE, z - sinH * SLOPE_SAMPLE_LENGTHWISE);
      const hRight = this.hf.heightAt(x - sinH * SLOPE_SAMPLE_CROSSWISE, z + cosH * SLOPE_SAMPLE_CROSSWISE);
      const hLeft = this.hf.heightAt(x + sinH * SLOPE_SAMPLE_CROSSWISE, z - cosH * SLOPE_SAMPLE_CROSSWISE);
      targetPitch = THREE.MathUtils.clamp(Math.atan2(hFwd - hBack, 2 * SLOPE_SAMPLE_LENGTHWISE), -MAX_TILT, MAX_TILT);
      targetRoll = THREE.MathUtils.clamp(Math.atan2(hRight - hLeft, 2 * SLOPE_SAMPLE_CROSSWISE), -MAX_TILT, MAX_TILT);
    }
    state.slopePitch = damp(state.slopePitch, targetPitch, SLOPE_LAMBDA, dt);
    state.slopeRoll = damp(state.slopeRoll, targetRoll, SLOPE_LAMBDA, dt);

    rig.body.rotation.x = state.slopePitch + state.bodyPitchDip;
    rig.body.rotation.z = state.slopeRoll;
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

    const excavatorState = this.states.get('excavator');
    const excavatorActive =
      this.clock - (this.lastSeenAt.get('excavator') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updateExcavator(excavatorState, excavatorActive, dt);

    const truckState = this.states.get('truck');
    const truckActive = this.clock - (this.lastSeenAt.get('truck') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updateTruck(truckState, truckActive, dt);
    this.updateTruckShuttle(dt, excavatorActive);
    this.updateTruckPavedDock(dt, truckActive);

    const paverState = this.states.get('paver');
    const paverActive = this.clock - (this.lastSeenAt.get('paver') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updatePaverMat(paverState, paverActive, dt);

    this.updateRoller(dt, rollerActive);

    this.updateTireMarks(dt);
    this.updateFloodlight(dt, night);
    this.updateSiteDressing(dt);

    this.dustPool.update(dt);
    this.steamPool.update(dt);
    this.gravelPool.update(dt);
    this.tireMarks.update(dt);
    this.stakes.update(dt);
    this.cones.update(dt, this.dressingActive, this.dressingPos, this.dressingHeading);
  }

  // scratch fields for updateSiteDressing -> cones.update handoff (avoids a per-frame allocation)
  private dressingActive = false;
  private dressingPos = new THREE.Vector3();
  private dressingHeading = 0;

  /**
   * Site dressing (deliverable 5): finds whichever vehicle is currently the "primary" active one
   * (same anchor-picking approach as updateFloodlight) to serve as the work front for bracketing
   * cones, and fades the job-start stockpile in/out with whether ANY job is currently active
   * (cones/stockpile both belong to "a job is in progress somewhere", not any one vehicle kind).
   */
  private updateSiteDressing(dt: number): void {
    let anchor: VehicleState | null = null;
    for (const [kind, state] of this.states) {
      const lastSeen = this.lastSeenAt.get(kind) ?? -Infinity;
      if (this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget) {
        anchor = state;
        break;
      }
    }

    this.dressingActive = anchor !== null;
    if (anchor) {
      this.dressingPos.copy(anchor.curPos);
      this.dressingHeading = anchor.curHeading;
    }

    const jobActive = anchor !== null;
    this.stockpileVisibility = damp(this.stockpileVisibility, jobActive ? 1 : 0, 1 / FADE_DURATION, dt);
    const scale = easeOutCubic(clamp01(this.stockpileVisibility));
    this.stockpile.group.visible = scale > 0.001;
    this.stockpile.group.scale.setScalar(Math.max(0.001, scale));
    if (!jobActive) this.stockpileEdgeId = null; // free the anchor once fully faded/no job running
  }

  /**
   * Procedural dig-swing-dump cycle: three explicit phases derived from a single 0..1 progress
   * value looping every DIG_CYCLE_DURATION seconds. `digPhase` is only advanced while the
   * excavator is active AND hasn't relocated more than RELOCATE_THRESHOLD this frame (a same-kind
   * edge handoff or a big damped jump snaps the target far away in one step) — otherwise the rig
   * eases toward a neutral carry pose instead of digging mid-teleport, and the cycle resumes from
   * wherever it left off once the vehicle is back to normal, small-per-frame motion.
   */
  private updateExcavator(state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = this.rigs.excavator;
    if (!state) {
      rig.boom!.rotation.z = damp(rig.boom!.rotation.z, CARRY_BOOM_Z, RELOCATE_LAMBDA, dt);
      rig.stick!.rotation.z = damp(rig.stick!.rotation.z, CARRY_STICK_Z, RELOCATE_LAMBDA, dt);
      rig.bucket!.rotation.z = damp(rig.bucket!.rotation.z, CARRY_BUCKET_Z, RELOCATE_LAMBDA, dt);
      return;
    }

    const relocating = state.curPos.distanceTo(state.prevPos) > RELOCATE_THRESHOLD;
    state.digPaused = !active || relocating;

    if (!state.digPaused) {
      const prevPhase = state.digPhase;
      state.digPhase = (state.digPhase + dt) % DIG_CYCLE_DURATION;
      const p = state.digPhase / DIG_CYCLE_DURATION; // 0..1 normalized

      let boomZ: number, stickZ: number, bucketZ: number, cabYaw: number;
      if (p < DIG_PHASE.approach) {
        // approach: reach boom/stick down toward the ground ahead
        const u = easeOutCubic(p / DIG_PHASE.approach);
        boomZ = THREE.MathUtils.lerp(CARRY_BOOM_Z, 0.15, u);
        stickZ = THREE.MathUtils.lerp(CARRY_STICK_Z, 1.5, u);
        bucketZ = THREE.MathUtils.lerp(CARRY_BUCKET_Z, -0.3, u);
        cabYaw = 0;
      } else if (p < DIG_PHASE.dig) {
        // dig: bucket curls into the ground — dust burst right at contact (phase entry)
        const u = easeOutCubic((p - DIG_PHASE.approach) / (DIG_PHASE.dig - DIG_PHASE.approach));
        boomZ = THREE.MathUtils.lerp(0.15, 0.05, u);
        stickZ = THREE.MathUtils.lerp(1.5, 1.7, u);
        bucketZ = THREE.MathUtils.lerp(-0.3, 0.6, u);
        cabYaw = 0;
        if (prevPhase / DIG_CYCLE_DURATION < DIG_PHASE.approach) {
          this.emitDust(state.curPos.x + Math.cos(state.curHeading) * 2.5, state.curPos.y, state.curPos.z + Math.sin(state.curHeading) * 2.5);
        }
      } else if (p < DIG_PHASE.lift) {
        // lift: boom+stick raise the full bucket, cab begins yawing toward the dump (truck) side
        const u = easeOutCubic((p - DIG_PHASE.dig) / (DIG_PHASE.lift - DIG_PHASE.dig));
        boomZ = THREE.MathUtils.lerp(0.05, -0.5, u);
        stickZ = THREE.MathUtils.lerp(1.7, 0.6, u);
        bucketZ = THREE.MathUtils.lerp(0.6, 0.1, u);
        cabYaw = CAB_YAW_AMOUNT * u;
      } else if (p < DIG_PHASE.dump) {
        // dump: cab holds/reaches full yaw, bucket opens — dust burst at the dump moment
        const u = easeOutCubic((p - DIG_PHASE.lift) / (DIG_PHASE.dump - DIG_PHASE.lift));
        boomZ = -0.5;
        stickZ = THREE.MathUtils.lerp(0.6, 0.3, u);
        bucketZ = THREE.MathUtils.lerp(0.1, -0.9, u);
        cabYaw = CAB_YAW_AMOUNT;
        if (prevPhase / DIG_CYCLE_DURATION < DIG_PHASE.lift + (DIG_PHASE.dump - DIG_PHASE.lift) * 0.5 && u >= 0.5) {
          const dumpX = state.curPos.x + Math.cos(state.curHeading + Math.PI / 2 * Math.sign(CAB_YAW_AMOUNT)) * 3;
          const dumpZ = state.curPos.z + Math.sin(state.curHeading + Math.PI / 2 * Math.sign(CAB_YAW_AMOUNT)) * 3;
          this.emitDust(dumpX, state.curPos.y + 1.5, dumpZ);
          // Truck shuttle theater (deliverable 3): each dig-cycle dump lands a load of spoil in
          // the idling truck's bed, purely cosmetic — the excavator keeps digging on its own
          // sim-driven schedule whether or not the truck happens to be present at all.
          if (state.stage === 'graded' && !state.demolish) this.truckReceiveDump();
        }
      } else {
        // swing back: cab yaws back to center, arm returns toward the carry pose
        const u = easeOutCubic((p - DIG_PHASE.dump) / (1 - DIG_PHASE.dump));
        boomZ = THREE.MathUtils.lerp(-0.5, CARRY_BOOM_Z, u);
        stickZ = THREE.MathUtils.lerp(0.3, CARRY_STICK_Z, u);
        bucketZ = THREE.MathUtils.lerp(-0.9, CARRY_BUCKET_Z, u);
        cabYaw = CAB_YAW_AMOUNT * (1 - u);
      }

      rig.boom!.rotation.z = boomZ;
      rig.stick!.rotation.z = stickZ;
      rig.bucket!.rotation.z = bucketZ;
      rig.cab!.rotation.y = damp(rig.cab!.rotation.y, cabYaw, ROT_LAMBDA, dt);

      // track tread illusion: two boxes stepping in a sawtooth offset while the vehicle works,
      // giving the impression of continuous tread motion without a scrolling texture.
      const treadCycle = (this.clock * 2.4) % 1;
      rig.trackTreadA!.position.x = 0.6 - treadCycle * 1.2;
      rig.trackTreadB!.position.x = -0.6 + ((treadCycle + 0.5) % 1) * 1.2 - 0.6;
    } else {
      // paused/relocating: ease every pivot toward the neutral carry pose
      rig.boom!.rotation.z = damp(rig.boom!.rotation.z, CARRY_BOOM_Z, RELOCATE_LAMBDA, dt);
      rig.stick!.rotation.z = damp(rig.stick!.rotation.z, CARRY_STICK_Z, RELOCATE_LAMBDA, dt);
      rig.bucket!.rotation.z = damp(rig.bucket!.rotation.z, CARRY_BUCKET_Z, RELOCATE_LAMBDA, dt);
      rig.cab!.rotation.y = damp(rig.cab!.rotation.y, 0, RELOCATE_LAMBDA, dt);
    }

    if (active) {
      this.dustTimer += dt;
      if (this.dustTimer >= DUST_INTERVAL) {
        this.dustTimer = 0;
        this.emitDust(state.curPos.x, state.curPos.y, state.curPos.z);
      }
    } else {
      this.dustTimer = 0;
    }
  }

  /**
   * Dump truck bed tipping: while depositing gravel at the work front (stage === 'gravel', not
   * demolishing — reversing a demolish crew doesn't deposit anything), tips the bed up to
   * BED_TIP_ANGLE and back down every BED_TIP_INTERVAL seconds, eased over BED_TIP_DURATION each
   * way, with a gravel-colored particle burst at the tailgate while tipped.
   */
  private updateTruck(state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = this.rigs.truck;
    if (!state || !active || state.stage !== 'gravel' || state.demolish) {
      if (state) {
        state.bedTipTimer = 0;
        // Reset the tip-cycle state too (not just the timer) so if this truck re-enters 'gravel'
        // later, the tip animation starts fresh from a flat bed rather than resuming mid-cycle
        // with a stale bedTipAngle that would jump discontinuously against the already-eased
        // rotation.z below.
        state.bedTipElapsed = 0;
        state.bedTipAngle = 0;
      }
      // 'paved' owns bedPivot.rotation.z exclusively via updateTruckPavedDock (called right after
      // this method in update()) — leave it untouched here rather than relying on call order to
      // "win" the last write; every other non-'gravel' stage still eases the bed flat as before.
      if (!state || state.stage !== 'paved') {
        rig.bedPivot!.rotation.z = damp(rig.bedPivot!.rotation.z, 0, RELOCATE_LAMBDA, dt);
      }
      return;
    }

    state.bedTipTimer += dt;
    if (state.bedTipTimer >= BED_TIP_INTERVAL && state.bedTipElapsed === 0) {
      state.bedTipElapsed = 0.00001; // kick off the tip-up/tip-down animation
      state.bedTipTimer = 0;
    }

    if (state.bedTipElapsed > 0) {
      state.bedTipElapsed += dt;
      const totalDuration = BED_TIP_DURATION * 2;
      if (state.bedTipElapsed >= totalDuration) {
        state.bedTipElapsed = 0;
        state.bedTipAngle = 0;
      } else if (state.bedTipElapsed <= BED_TIP_DURATION) {
        state.bedTipAngle = easeOutCubic(state.bedTipElapsed / BED_TIP_DURATION) * BED_TIP_ANGLE;
      } else {
        const u = (state.bedTipElapsed - BED_TIP_DURATION) / BED_TIP_DURATION;
        state.bedTipAngle = BED_TIP_ANGLE * (1 - easeOutCubic(u));
      }
    }

    rig.bedPivot!.rotation.z = state.bedTipAngle;

    if (state.bedTipAngle > BED_TIP_ANGLE * 0.5) {
      // gravel burst at the tailgate (rear, -x local -> world via heading) while tipped
      const tailX = state.curPos.x - Math.cos(state.curHeading) * 2.2;
      const tailZ = state.curPos.z - Math.sin(state.curHeading) * 2.2;
      if (Math.random() < 0.5) {
        this.gravelPool.spawn(
          tailX + (Math.random() - 0.5) * 0.8,
          state.curPos.y + 0.3,
          tailZ + (Math.random() - 0.5) * 0.8,
          -Math.cos(state.curHeading) * 0.4,
          -0.6 - Math.random() * 0.4,
          -Math.sin(state.curHeading) * 0.4,
        );
      }
    }
  }

  /** Called from `updateExcavator`'s dig-cycle dump moment while the excavator is grading and the
   * truck is idling beside it: grows the truck bed's spoil mound one step, and once it's received
   * SPOIL_DUMPS_TO_FILL loads, kicks off the "full — drive off to dump" phase. Purely cosmetic. */
  private truckReceiveDump(): void {
    const truck = this.states.get('truck');
    if (!truck || truck.shuttlePhase !== 'idle') return;
    truck.dumpCountThisLoad += 1;
    truck.spoilLevel = clamp01(truck.dumpCountThisLoad / SPOIL_DUMPS_TO_FILL);
    if (truck.dumpCountThisLoad >= SPOIL_DUMPS_TO_FILL) {
      truck.shuttlePhase = 'departing';
      truck.shuttleTimer = 0;
      truck.shuttleAwayDuration = SHUTTLE_AWAY_MIN + Math.random() * (SHUTTLE_AWAY_MAX - SHUTTLE_AWAY_MIN);
      const dir = nearestEdgeDir(truck.curPos.x, truck.curPos.z);
      truck.shuttleAwayPos.set(
        truck.curPos.x + dir.x * SPAWN_DISTANCE,
        truck.curPos.y,
        truck.curPos.z + dir.z * SPAWN_DISTANCE,
      );
    }
  }

  /**
   * Drives the truck's departing -> away -> returning -> idle cycle once its bed reads "full"
   * (see truckReceiveDump above). Entirely render-side theater: while the truck is off-cycle, its
   * `targetPos`/`targetHeading` are driven directly here (overriding the onProgress-synthesized
   * idle-anchor position) and `stepVehicle`'s usual POS_LAMBDA/ROT_LAMBDA damping carries it along,
   * since there's no underlying sim event stream to follow during this excursion. The excavator
   * itself is completely unaffected — it keeps digging on the sim's own schedule whether or not
   * the truck happens to be present, per the spec's "sim timing unchanged".
   */
  private updateTruckShuttle(dt: number, excavatorActive: boolean): void {
    const truck = this.states.get('truck');
    if (!truck || !truck.hasTarget) return;

    if (truck.shuttlePhase === 'idle') return;

    if (!excavatorActive) {
      // The graded job itself ended (edge finished/excavator idle-timed-out) while the truck was
      // mid-shuttle — don't strand it forever mid-cycle; drop back to 'idle' so the normal
      // onProgress/handoff/idle-timeout fade logic takes back over cleanly next time this vehicle
      // gets a real progress event (e.g. a future job elsewhere).
      truck.shuttlePhase = 'idle';
      truck.dumpCountThisLoad = 0;
      truck.spoilLevel = 0;
      return;
    }

    const rig = this.rigs.truck;

    if (truck.shuttlePhase === 'departing') {
      truck.targetPos.copy(truck.shuttleAwayPos);
      // Heading tracks the goal down to a much tighter distance than the arrival threshold below
      // (HEADING_FREEZE_EPS < SHUTTLE_ARRIVE_EPS*4) so it never goes stale for the last stretch of
      // travel before the phase flips — a prior version froze heading and flipped phase at the
      // same threshold, which could pop the rig's facing right at the transition.
      const toGoal = new THREE.Vector3().subVectors(truck.shuttleAwayPos, truck.curPos);
      if (toGoal.length() > HEADING_FREEZE_EPS) {
        truck.targetHeading = Math.atan2(toGoal.z, toGoal.x);
      }
      if (truck.curPos.distanceTo(truck.shuttleAwayPos) <= SHUTTLE_ARRIVE_EPS * 4) {
        // "dumps offscreen — just fades at distance": once close to the map edge, fade the rig
        // out via the same scale mechanism as an idle-timeout, without touching lastSeenAt (which
        // would otherwise make onProgress's idle-anchor logic think the job stopped).
        truck.shuttlePhase = 'away';
        truck.shuttleTimer = 0;
      }
    } else if (truck.shuttlePhase === 'away') {
      truck.shuttleTimer += dt;
      if (truck.shuttleTimer >= truck.shuttleAwayDuration) {
        truck.shuttlePhase = 'returning';
        truck.dumpCountThisLoad = 0;
        truck.spoilLevel = 0;
        // Empty the visible spoil mound immediately — it dumped off-map during the 'away' hold.
        rig.spoilMesh!.scale.setScalar(0.001);
      }
    } else if (truck.shuttlePhase === 'returning') {
      truck.targetPos.copy(truck.shuttleReturnPos);
      const toGoal = new THREE.Vector3().subVectors(truck.shuttleReturnPos, truck.curPos);
      if (toGoal.length() > HEADING_FREEZE_EPS) {
        truck.targetHeading = Math.atan2(toGoal.z, toGoal.x);
      }
      if (truck.curPos.distanceTo(truck.shuttleReturnPos) <= SHUTTLE_ARRIVE_EPS) {
        truck.shuttlePhase = 'idle';
      }
    }

    // Spoil mound scale tracks spoilLevel (grows per dump, resets on departure/return) — eased via
    // a simple damp toward the target scale so a dump doesn't pop the lump in instantly.
    const targetSpoilScale = truck.shuttlePhase === 'idle' || truck.shuttlePhase === 'departing' ? truck.spoilLevel : 0;
    rig.spoilMesh!.scale.setScalar(Math.max(0.001, damp(rig.spoilMesh!.scale.y, targetSpoilScale, 6, dt)));
  }

  /**
   * Truck docked at the paver hopper during 'paved' work (deliverable 3): a slow, shallow,
   * continuously-oscillating bed tip standing in for "gradually feeding material into the
   * hopper" — distinct from the sharper gravel-deposit tip cycle in `updateTruck`, which only
   * fires during 'gravel'. The truck's dock *position* itself is synthesized in onProgress; this
   * only drives the bed pivot while it's stage 'paved' and actively parked there.
   */
  private updateTruckPavedDock(dt: number, truckActive: boolean): void {
    const truck = this.states.get('truck');
    const rig = this.rigs.truck;
    const docked = !!truck && truckActive && truck.stage === 'paved' && !truck.demolish;
    const targetAngle = docked ? PAVED_DOCK_TIP_ANGLE * (0.5 + 0.5 * Math.sin(this.clock * PAVED_DOCK_TIP_LAMBDA * Math.PI * 2)) : 0;
    // Ownership split with updateTruck: updateTruck now explicitly skips writing bedPivot during
    // 'paved' (see its early-return branch), so this is the sole writer for that stage — no
    // dependency on call order between the two methods. Still guard on stage !== 'gravel' so this
    // method never fights updateTruck's own tip cycle if ever called while gravel-depositing.
    if (!truck || truck.stage !== 'gravel') {
      rig.bedPivot!.rotation.z = damp(rig.bedPivot!.rotation.z, targetAngle, RELOCATE_LAMBDA, dt);
    }
  }

  /**
   * Fresh-asphalt mat quad trailing the paver's rear: fades in while the paver is actively laying
   * (paved stage) and fades back out once the paver stops (the real ribbon geometry takes over
   * that stretch of road, so the mat shouldn't linger).
   */
  private updatePaverMat(state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = this.rigs.paver;
    const laying = !!state && active && state.stage === 'paved';
    const targetOpacity = laying ? 0.85 : 0;
    rig.matMat!.opacity = damp(rig.matMat!.opacity, targetOpacity, 1 / MAT_FADE_TIME, dt);
    rig.matMesh!.visible = rig.matMat!.opacity > 0.01;
  }

  /**
   * Roller passes: instead of pure trailing, oscillates back and forth around the trail point
   * (± ROLLER_OSCILLATION_RANGE) with direction flips, drum spinning proportional to the actual
   * oscillation displacement (reuses the same wheel-spin mechanism as stepVehicle, applied here
   * as an additional offset on top of the damped trail position).
   */
  private updateRoller(dt: number, active: boolean): void {
    const rig = this.rigs.roller;
    if (!active) {
      this.steamTimer = 0;
      return;
    }

    const prevOffset = this.roller.rollerOscOffset;
    this.roller.rollerOscOffset += this.roller.rollerOscDir * ROLLER_OSCILLATION_SPEED * dt;
    if (this.roller.rollerOscOffset > ROLLER_OSCILLATION_RANGE) {
      this.roller.rollerOscOffset = ROLLER_OSCILLATION_RANGE;
      this.roller.rollerOscDir = -1;
    } else if (this.roller.rollerOscOffset < -ROLLER_OSCILLATION_RANGE) {
      this.roller.rollerOscOffset = -ROLLER_OSCILLATION_RANGE;
      this.roller.rollerOscDir = 1;
    }

    const offsetDelta = this.roller.rollerOscOffset - prevOffset;
    const forwardX = Math.cos(this.roller.curHeading);
    const forwardZ = Math.sin(this.roller.curHeading);
    rig.group.position.x += forwardX * this.roller.rollerOscOffset;
    rig.group.position.z += forwardZ * this.roller.rollerOscOffset;
    // face the direction it's currently oscillating toward so it visibly reads as passes, not drift
    rig.group.rotation.y = -(this.roller.rollerOscDir > 0 ? this.roller.curHeading : this.roller.curHeading + Math.PI);

    for (const w of rig.wheels) {
      w.mesh.rotation.x += Math.abs(offsetDelta) / w.radius;
    }

    this.steamTimer += dt;
    if (this.steamTimer >= STEAM_INTERVAL) {
      this.steamTimer = 0;
      this.emitSteam(rig.group.position.x, rig.group.position.y, rig.group.position.z);
    }
  }

  /**
   * Tire/track marks: fading instanced decals stamped under moving vehicles while the terrain is
   * still dirt (graded/gravel stages) — paved/painted stages have a hard surface, no marks. Each
   * active vehicle stamps at most once every TIRE_MARK_INTERVAL seconds so the ≤256 pool covers a
   * good stretch of road without instantly cycling through on a single pass.
   */
  private updateTireMarks(dt: number): void {
    for (const state of [...this.states.values(), this.roller]) {
      if (!state.hasTarget) continue;
      const marking = (state.stage === 'graded' || state.stage === 'gravel') && state.curSpeed > 0.2;
      if (!marking) {
        state.tireMarkTimer = 0;
        continue;
      }
      state.tireMarkTimer += dt;
      if (state.tireMarkTimer >= TIRE_MARK_INTERVAL) {
        state.tireMarkTimer = 0;
        this.tireMarks.stamp(state.curPos.x, state.curPos.y, state.curPos.z, state.curHeading, 1.6, 1.2);
      }
    }
  }

  /**
   * Floodlight-tower prop: appears near the work front when it's night AND a job is actively
   * being reported (any vehicle kind active this frame), easing in/out with both day/night and
   * job start/end rather than popping — `floodlightVisibility` chases 1 only when both conditions
   * hold simultaneously, so a job that's already running when night falls eases the light in, and
   * a job that finishes mid-night eases it back out, exactly like a job starting after dark does.
   * Positioned just off to the side of whichever vehicle is currently the primary one (first
   * active found).
   */
  private updateFloodlight(dt: number, night: boolean): void {
    let anchor: VehicleState | null = null;
    for (const [kind, state] of this.states) {
      const lastSeen = this.lastSeenAt.get(kind) ?? -Infinity;
      if (this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget) {
        anchor = state;
        break;
      }
    }

    const wantVisible = night && anchor !== null;
    const target = wantVisible ? 1 : 0;
    this.floodlightVisibility = damp(this.floodlightVisibility, target, 1 / FLOODLIGHT_EASE, dt);

    const visible = this.floodlightVisibility > 0.01;
    this.floodlight.group.visible = visible;
    if (visible && anchor) {
      const perpX = -Math.sin(anchor.curHeading);
      const perpZ = Math.cos(anchor.curHeading);
      this.floodlight.group.position.set(
        anchor.curPos.x + perpX * 6,
        anchor.curPos.y,
        anchor.curPos.z + perpZ * 6,
      );
      this.floodlight.group.rotation.y = -anchor.curHeading + Math.PI / 2;
    }

    this.floodlight.light.intensity = this.floodlightVisibility * 6;
    this.floodlight.headMat.emissiveIntensity = this.floodlightVisibility * 2.2;
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
    this.scene.remove(this.gravelPool.points);
    this.scene.remove(this.tireMarks.mesh);
    this.scene.remove(this.stakes.mesh);
    this.scene.remove(this.cones.mesh);
    this.dustPool.dispose();
    this.steamPool.dispose();
    this.gravelPool.dispose();
    this.tireMarks.dispose();
    this.stakes.dispose();
    this.cones.dispose();

    this.scene.remove(this.stockpile.group);
    this.stockpile.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    for (const m of this.stockpile.materials) m.dispose();

    this.scene.remove(this.floodlight.group);
    this.floodlight.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.floodlight.headMat.dispose();
    this.floodlight.poleMat.dispose();
  }
}

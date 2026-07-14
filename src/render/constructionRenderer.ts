import * as THREE from 'three';
import type { VehicleKind, Stage, RoadSample } from '../core/types';
import { STAGES } from '../core/types';
import { EventBus } from '../core/events';
import { RoadGraph } from '../sim/roads/graph';
import { sampleAt } from '../sim/roads/path';
import { Heightfield } from '../sim/terrain/heightfield';
import { damp, easeOutCubic, easeOutBack, clamp01 } from './easing';
import { ROAD_WIDTH, WORLD_SIZE } from '../core/constants';
import { RoadRenderer, getBridgeRunInfo, BRIDGE_PYLON_SPACING, STAGE_COLOR } from './roadRenderer';
import { MAX_CREWS } from '../sim/construction/queue';
import { QuarrySim, type QuarryPlacement } from '../sim/quarry';

/** Vehicle kinds that get their own rig SET per crew (Task 25). 'crane' is deliberately excluded —
 * it remains a single shared rig globally (bridges are rare; if two crews hit bridge runs at the
 * same time, the second crew's spans still settle correctly, just without the crane visual — see
 * `ConstructionRenderer`'s class doc). */
const PER_CREW_KINDS: Exclude<VehicleKind, 'crane'>[] = [
  'excavator', 'truck', 'paver', 'roller', 'liner', 'surveyor',
];

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
const APPROACH_TERRAIN_EPS = 4; // u (horizontal, to target); within this, blend Y onto the target
                                // instead of terrain — avoids a last-moment snap onto the road grade

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
const TIRE_MARK_POOL_SIZE = 768;
const TIRE_MARK_FADE = 20; // seconds
const TIRE_MARK_INTERVAL = 0.25; // seconds between mark stamps per active vehicle
const TIRE_MARK_COLOR = '#2a2420';

export interface GroundContactMark {
  lateral: number;
  longitudinal: number;
  width: number;
  length: number;
}

const FOUR_WHEEL_CONTACTS: GroundContactMark[] = [
  { lateral: -0.62, longitudinal: -0.72, width: 0.28, length: 0.48 },
  { lateral: 0.62, longitudinal: -0.72, width: 0.28, length: 0.48 },
  { lateral: -0.62, longitudinal: 0.72, width: 0.28, length: 0.48 },
  { lateral: 0.62, longitudinal: 0.72, width: 0.28, length: 0.48 },
];
const TRACKED_CONTACTS: GroundContactMark[] = [
  { lateral: -0.72, longitudinal: 0, width: 0.42, length: 1.35 },
  { lateral: 0.72, longitudinal: 0, width: 0.42, length: 1.35 },
];
const GRADER_CONTACTS: GroundContactMark[] = [-1, 0, 1].flatMap((longitudinal) => [
  { lateral: -0.62, longitudinal, width: 0.26, length: 0.44 },
  { lateral: 0.62, longitudinal, width: 0.26, length: 0.44 },
]);
const ROLLER_CONTACTS: GroundContactMark[] = [
  { lateral: 0, longitudinal: -0.62, width: 1.55, length: 0.42 },
  { lateral: 0, longitudinal: 0.62, width: 1.4, length: 0.42 },
];

/** Contact patches stamped into dirt/gravel for each physical vehicle layout. Returned arrays are
 * immutable conventions; callers must not mutate them. */
export function vehicleGroundContacts(kind: VehicleKind | 'grader'): ReadonlyArray<GroundContactMark> {
  if (kind === 'excavator' || kind === 'paver') return TRACKED_CONTACTS;
  if (kind === 'truck' || kind === 'liner') return FOUR_WHEEL_CONTACTS;
  if (kind === 'grader') return GRADER_CONTACTS;
  if (kind === 'roller') return ROLLER_CONTACTS;
  return [];
}

// --- Floodlight (Task 37: towers stake down at fixed stations, like the T27 cones) -------------
// Construction lighting density has been expanded twice: the original 70u/6-tower budget became
// 35u/12 in Task 45 and is now 17.5u/24 per crew. The alternating-sides, bridge-avoidance, and
// cap-then-widen behavior remains unchanged; the real-light budget stays one SpotLight per crew.
const FLOODLIGHT_EASE = 1.2; // seconds to ease in/out with night + job-active state
const FLOODLIGHT_COLOR = '#ffcf8a';
const FLOODLIGHT_SPACING = 17.5; // target arclength (u) between successive tower stations (was 35)
const FLOODLIGHT_PERP_OFFSET = ROAD_WIDTH_HALF + 2.2; // ± units from the centerline, per spec
const FLOODLIGHT_CAP = 24; // per-crew tower budget (was 12) — mirrors CONE_CAP's cap-then-widen-spacing approach
const FLOODLIGHT_STATION_MERGE_DIST = 8; // u; displaced bridge-avoidance stations within this
                                          // arclength of another chosen station are dropped as duplicates
const FLOODLIGHT_LIGHT_EASE = 0.8; // seconds to cross-fade the single shared SpotLight between towers

// --- Task 45: visible cast light per tower (ground pool + downward cone) -----------------------
// Cheap "visible cast light" trick, same family as carRenderer's headlight glow-quad/beam-cone
// pair: one InstancedMesh each for the warm ground pool and the downward light cone, shared across
// ALL crews (not per-crew) since they're purely additive decals with no per-crew material state.
// Bounded at MAX_CREWS * FLOODLIGHT_CAP instances each (3*24 = 72) regardless of how many towers
// are actually live at once.
const FLOODLIGHT_POOL_RADIUS = 7; // u, ground pool ellipse radius
const FLOODLIGHT_POOL_OPACITY = 0.25;
const FLOODLIGHT_POOL_COLOR = '#ffb862';
const FLOODLIGHT_CONE_TOP_RADIUS = 0.55; // u, matches the head's footprint at the top of the cone
const FLOODLIGHT_CONE_OPACITY = 0.15;
// Task 45 deliverable 3: emissive head intensity bumped (2.2 -> 3.1) so heads read clearly as the
// light source at night, not just a lit prop — same multiplier-by-floodlightVisibility eased signal.
const FLOODLIGHT_HEAD_EMISSIVE = 3.1;

// --- Bridge construction theater (Task 22) -----------------------------------------------------
const BRIDGE_SPAN_LENGTH = BRIDGE_PYLON_SPACING; // 16u, matches roadRenderer's pylon spacing/deck masking
const SEGMENT_DROP_HEIGHT = 8; // u above the deck the segment starts its descent from
const SEGMENT_DESCEND_DURATION = 1.5; // seconds, easeOutCubic
const SEGMENT_SETTLE_BOUNCE_DURATION = 0.35; // seconds, easeOutBack tiny settle bounce after descent
const CRANE_SLEW_LAMBDA = 4; // damping for the cab's yaw tracking the current span

// --- Site realism (Task 26) ---------------------------------------------------------------------
const HI_VIS_ORANGE = '#e8641b'; // spec-mandated hi-vis torso color for worker figures
const HARDHAT_COLOR = '#f2c94c';
const WORKER_FADE_LAMBDA = 1 / FADE_DURATION; // workers fade with the rest of the crew's dressing

// Flagger: stands just off the cone bracket, slow arm-wave cycle.
const FLAGGER_WAVE_HZ = 0.5;
const FLAGGER_WAVE_AMOUNT = THREE.MathUtils.degToRad(35);

// Spotter: paces the active vehicle from ~4u away, damped walk-steps as the work front advances.
const SPOTTER_STANDOFF = 4; // u from the active vehicle
const SPOTTER_LAMBDA = 4; // position damping, slower than vehicles so it reads as "walking to keep up"
const SPOTTER_STEP_HZ = 1.6; // walk-step bob rate while actively repositioning
const SPOTTER_BOB_AMOUNT = 0.05; // u, small vertical bob while walking
const SPOTTER_MOVE_EPS = 0.05; // u/s; below this the spotter reads as "standing", no bob

// Stockpile worker: idles near the stockpile, occasional shovel-lean cycle.
const SHOVEL_CYCLE_DURATION = 3.2; // seconds per lean-and-scoop cycle
const SHOVEL_CYCLE_CHANCE = 0.4; // fraction of the time a cycle actually plays (otherwise stands idle)
const SHOVEL_IDLE_GAP_MIN = 1.5;
const SHOVEL_IDLE_GAP_MAX = 4;

// Motor grader (deliverable 2): trails the dump truck's gravel drops, blade lowered, leveling the
// ribbon (visual only — the ribbon already renders; the grader is theater).
const GRADER_TRAIL_DISTANCE = 6; // u behind the work front, per spec
const GRADER_COLOR = '#c9a227';

// Exhaust puffs (deliverable 3): reuse the ParticlePool mechanism at a subtle rate.
const EXHAUST_INTERVAL = 0.8; // seconds between puffs per active vehicle
const EXHAUST_LIFETIME = 1.4;
const EXHAUST_SIZE = 0.7;
const EXHAUST_COLOR = '#38352f';
const EXHAUST_POOL_SIZE = 120;

// Stockpile depletion (deliverable 4): mound scale lerps from 1 (survey) down to STOCKPILE_MIN_SCALE
// (painting) across the job's stage progression.
const STOCKPILE_MIN_SCALE = 0.2;
const STOCKPILE_SCALE_LAMBDA = 3; // damping so depletion eases rather than snaps at each stage change

// Paint stencil (deliverable 5) — the wet-sheen roughness lerp on fresh dashes itself lives in
// roadRenderer.ts (mirrors its own fresh-asphalt pattern; see WET_SHEEN_DURATION there).
const STENCIL_TRAIL = 1.6; // u behind the liner's nozzle
const CENTERLINE_STENCIL_HALF_WIDTH = 0.35; // u, matches roadRenderer's CENTERLINE_WIDTH/2 (0.5/2 + slack)

// Plate compactor (deliverable 2, second prop — the Addendum B line item deferred from the
// original Task 26 pass): a walk-behind rig working the shoulder beside the freshest center
// dashes, trailing the liner. Pure render theater like the grader — no VehicleKind, queue.ts
// untouched.
const COMPACTOR_TRAIL_DISTANCE = 5; // u behind the liner's nozzle, clear of the flagger cluster
const COMPACTOR_SIDE_OFFSET = ROAD_WIDTH_HALF + 0.9; // parked on the shoulder, off the fresh dashes
const COMPACTOR_BRIDGE_SIDE_OFFSET = ROAD_WIDTH_HALF - 0.5; // over water: pulled in onto the deck
const COMPACTOR_LAMBDA = 4; // damped repositioning at walk-behind pace (same feel as SPOTTER_LAMBDA)
const COMPACTOR_VIBE_HZ = 9; // plate-vibration bob rate while working
const COMPACTOR_VIBE_AMOUNT = 0.02; // u, barely-there — zen constraint
const COMPACTOR_COLOR = '#d0721f';

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
 * arriving vehicles offscreen (Task 21 deliverable 4) and, pre-Task-34 (no quarry placed yet), to
 * send a "full" shuttle truck off to dump out of view (deliverable 3). Picks whichever of
 * +x/-x/+z/-z boundary is closest. */
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

/**
 * Task 34: the shuttle's "away" destination from `pos` — heads toward the quarry once one exists,
 * otherwise falls back to the pre-Task-34 "toward the nearest map edge" behavior unchanged. When a
 * quarry exists but sits farther than SPAWN_DISTANCE away, the truck heads along the straight-line
 * direction toward it and (per spec) still only travels SPAWN_DISTANCE before fading mid-route —
 * the theater budget is unchanged, it just now reads as "driving toward the quarry" rather than
 * "driving toward the map edge". When the quarry is closer than SPAWN_DISTANCE, the destination is
 * the quarry's actual position (no overshoot past the landmark).
 */
function shuttleAwayTarget(
  x: number,
  z: number,
  quarry: { x: number; z: number } | null,
): { x: number; y: number | null; z: number } {
  if (!quarry) {
    const dir = nearestEdgeDir(x, z);
    return { x: x + dir.x * SPAWN_DISTANCE, y: null, z: z + dir.z * SPAWN_DISTANCE };
  }
  const dx = quarry.x - x, dz = quarry.z - z;
  const dist = Math.hypot(dx, dz);
  if (dist <= SPAWN_DISTANCE || dist < 1e-6) {
    return { x: quarry.x, y: null, z: quarry.z };
  }
  const ux = dx / dist, uz = dz / dist;
  return { x: x + ux * SPAWN_DISTANCE, y: null, z: z + uz * SPAWN_DISTANCE };
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

  // liner stencil frame only (Task 26 deliverable 5)
  stencilMesh?: THREE.Group;
  stencilMat?: THREE.MeshStandardMaterial;

  // crane articulation only (Task 22)
  craneCab?: THREE.Group; // slews (yaws) to track the current span being placed
  craneBoom?: THREE.Group; // lattice boom, pitches slightly but mostly just carries the cable/hook
  craneCable?: THREE.Mesh; // thin cylinder, scale-Y = current cable length (hook drop)
  craneHook?: THREE.Group; // hangs at the cable's end (see buildCraneSegment for why the actual
                            // descending deck segment mesh is NOT parented here)
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

  // Paint stencil frame (deliverable 5): a thin rectangular frame lying flat on the road just
  // behind the nozzle, standing in for the guide stencil a real line-painting crew walks/tows over
  // the dash it's about to lay. Parented to `group` (not `body`) so it stays screen-flat regardless
  // of chassis pitch/roll, same reasoning as the paver's fresh-asphalt mat.
  const stencilMat = flatMat('#d8d4c8');
  stencilMat.transparent = true;
  stencilMat.opacity = 0;
  materials.push(stencilMat);
  const stencilMesh = new THREE.Group();
  stencilMesh.position.set(-STENCIL_TRAIL - 1.7, 0.05, 0);
  const railGeo = new THREE.BoxGeometry(1.0, 0.03, 0.05);
  for (const zSide of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, stencilMat);
    rail.position.set(0, 0, zSide * CENTERLINE_STENCIL_HALF_WIDTH);
    stencilMesh.add(rail);
  }
  const rungGeo = new THREE.BoxGeometry(0.05, 0.03, CENTERLINE_STENCIL_HALF_WIDTH * 2);
  for (const xSide of [-1, 1]) {
    const rung = new THREE.Mesh(rungGeo, stencilMat);
    rung.position.set(xSide * 0.475, 0, 0);
    stencilMesh.add(rung);
  }
  group.add(stencilMesh);

  return { kind: 'liner', group, body, beaconMat, wheels, materials, stencilMesh, stencilMat };
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

const CRANE_COLOR = '#c9c230';
const CRANE_LATTICE_COLOR = '#3c3f41';

/**
 * Lattice-boom crane rig (Task 22 deliverable 3), replacing the T21 placeholder now that it has a
 * real job: stationed at a bridge run's near end during 'gravel'-stage work crossing that run,
 * lowering deck segments into place. 11 primitives total (base, cab, counterweight, boom spine, 3
 * lattice struts, 2 A-frame legs, cable, hook) — comfortably under the ≤14 budget.
 *
 * Static geometry only: everything that actually animates (cab slew, cable length, hook position)
 * is applied per-frame in `updateCrane` via the named sub-parts below, exactly like the
 * excavator's boom/stick/bucket pivots.
 */
function buildCrane(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(CRANE_COLOR);
  const latticeMat = flatMat(CRANE_LATTICE_COLOR);
  const cableMat = flatMat('#1c1d1e');
  materials.push(bodyMat, latticeMat, cableMat);

  // base (fixed, doesn't slew)
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 2.2), bodyMat);
  base.position.y = 0.25;
  body.add(base);

  // slewing cab/turret — everything above this yaws to track the current span
  const cab = new THREE.Group();
  cab.position.y = 0.5;
  body.add(cab);

  const cabBody = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 1.3), bodyMat);
  cabBody.position.set(0, 0.4, 0);
  cab.add(cabBody);

  const counterweight = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 1.1), latticeMat);
  counterweight.position.set(-1.1, 0.5, 0);
  cab.add(counterweight);

  // A-frame legs bracing the boom's base, angled up and forward
  const legGeo = new THREE.BoxGeometry(0.18, 1.6, 0.18);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, latticeMat);
    leg.position.set(0.3, 1.2, side * 0.5);
    leg.rotation.z = THREE.MathUtils.degToRad(-20);
    cab.add(leg);
  }

  // Lattice boom: a main spine plus diagonal struts (the "lattice" reading), rising at a fixed
  // angle from just above the cab. Pivoted at its base so the whole assembly could in principle
  // pitch, though Task 22 only ever slews (yaws) it — the pitch stays fixed.
  const boom = new THREE.Group();
  boom.position.set(0.5, 1.7, 0);
  boom.rotation.z = THREE.MathUtils.degToRad(35); // rises up and forward
  cab.add(boom);

  const BOOM_LENGTH = 7.5;
  const spine = new THREE.Mesh(new THREE.BoxGeometry(BOOM_LENGTH, 0.22, 0.22), latticeMat);
  spine.position.set(BOOM_LENGTH / 2, 0, 0);
  boom.add(spine);

  const strutGeo = new THREE.BoxGeometry(0.08, 0.5, 0.08);
  for (let i = 0; i < 3; i++) {
    const u = (i + 1) / 4;
    const strut = new THREE.Mesh(strutGeo, latticeMat);
    strut.position.set(BOOM_LENGTH * u, 0, 0);
    strut.rotation.z = THREE.MathUtils.degToRad(45);
    boom.add(strut);
  }

  // Cable + hook hang from the boom tip. `craneCable` is a unit-length cylinder whose local origin
  // sits at its TOP (translated so it only ever grows downward) so scaling Y directly gives "cable
  // length" without needing to also reposition it every frame.
  const boomTip = new THREE.Group();
  boomTip.position.set(BOOM_LENGTH, 0, 0);
  boom.add(boomTip);

  const cableGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
  cableGeo.translate(0, -0.5, 0);
  const craneCable = new THREE.Mesh(cableGeo, cableMat);
  boomTip.add(craneCable);

  const craneHook = new THREE.Group();
  boomTip.add(craneHook);

  const hookMesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), latticeMat);
  craneHook.add(hookMesh);

  const beaconMat = addBeacon(cab, 2.2);

  return {
    kind: 'crane',
    group,
    body,
    beaconMat,
    wheels: [],
    materials,
    craneCab: cab,
    craneBoom: boom,
    craneCable,
    craneHook,
  };
}

/**
 * The deck segment currently being lowered into place (deliverable 3/4): a plain slab standing in
 * for a prefab bridge-deck section. Unlike the rest of the crane rig, this is NOT parented under
 * the crane's hook — the boom's fixed reach means the hook itself never actually travels out to a
 * span that may be many units down the run, so a hook-parented segment would visually hover right
 * next to the crane instead of over the water where it's actually landing. Built as a standalone
 * scene-level mesh instead, positioned directly at the span's real world location each frame by
 * `applyCraneArticulation` — the crane's cable/hook still animate (paying out as if lowering it)
 * for the "the crane is doing this" read, but the segment itself always appears where the deck
 * segment is actually going.
 */
function buildCraneSegment(): { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial } {
  const mat = new THREE.MeshStandardMaterial({
    color: STAGE_COLOR.gravel,
    flatShading: true,
    roughness: 0.9,
    transparent: true,
    opacity: 0,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), mat);
  mesh.name = 'crane-deck-segment';
  mesh.visible = false;
  return { mesh, mat };
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
const CONE_SPACING = 14; // target arclength (u) between successive flanking pairs
const CONE_PERP_OFFSET = ROAD_WIDTH_HALF + 0.8; // ± units from the centerline, per spec
const CONE_CAP = 48; // per-crew instance budget (Addendum C, Task 27) — 24 pairs max

/** Instanced traffic cones lining a crew's active job (Addendum C, Task 27): positions are
 * computed ONCE, when a crew's job starts on a given edge, from that edge's samples — a pair
 * flanking the roadway (±CONE_PERP_OFFSET) roughly every CONE_SPACING units of arclength, plus one
 * pair at each end, capped at CONE_CAP (spacing widens if the edge would otherwise need more).
 * They stay exactly where placed for the whole job (no re-tracking of the moving work front) and
 * simply fade in/out with the crew's dressing signal. One InstancedMesh — one draw call regardless
 * of instance count. */
class ConePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private liveCount = 0; // how many of CONE_CAP instances are placed for the current job
  private visibility = 0; // eased 0..1
  private placedEdgeId: number | null = null;

  constructor() {
    const geo = new THREE.ConeGeometry(0.28, 0.6, 8);
    geo.translate(0, 0.3, 0);
    const mat = flatMat('#e8641b', '#5a2200');
    this.mesh = new THREE.InstancedMesh(geo, mat, CONE_CAP);
    this.mesh.count = CONE_CAP;
    this.mesh.frustumCulled = false;
    this.posX = new Float32Array(CONE_CAP);
    this.posY = new Float32Array(CONE_CAP);
    this.posZ = new Float32Array(CONE_CAP);
  }

  /** Computes fixed cone positions along `samples` (an edge's road samples, already elevation- and
   * bridge-flagged) and uploads them once. Idempotent per edge: callers gate this behind "has this
   * crew's job just started on a new edge" (see `ConstructionRenderer.onProgress`) so re-placement
   * never happens mid-job. `hf` supplies ground height for non-bridge samples; bridge samples use
   * their own deck `y` directly (mirrors the convention elsewhere in this file — see
   * `nearestSampleBridge`). */
  place(edgeId: number, samples: RoadSample[], hf: Heightfield): void {
    this.placedEdgeId = edgeId;
    if (samples.length < 2) {
      this.liveCount = 0;
      return;
    }

    // Cumulative arclength per sample, so we can walk by distance rather than sample index.
    const dist = new Float32Array(samples.length);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      dist[i] = dist[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const total = dist[dist.length - 1];

    // Station list: both ends plus evenly-spaced interior stations. Widen spacing (rather than
    // dropping the end pairs) if the naive ~CONE_SPACING interval would exceed the per-crew cap.
    const maxPairs = CONE_CAP / 2;
    let interiorCount = total > 0 ? Math.floor(total / CONE_SPACING) : 0;
    // +1 for each end station beyond the interior ones (start=0, end=total already implied when
    // interiorCount counts intervals) — total stations = interiorCount + 1, clamp to the cap.
    let stationCount = Math.max(2, interiorCount + 1);
    if (stationCount > maxPairs) stationCount = maxPairs;

    const stations: number[] = [];
    if (stationCount <= 2) {
      stations.push(0, total);
    } else {
      for (let i = 0; i < stationCount; i++) {
        stations.push((total * i) / (stationCount - 1));
      }
    }

    let idx = 0;
    let sampleCursor = 0;
    for (const t of stations) {
      if (idx >= CONE_CAP) break;
      // Advance the cursor to the sample bracket containing arclength t.
      while (sampleCursor < samples.length - 2 && dist[sampleCursor + 1] < t) sampleCursor++;
      const a = samples[sampleCursor];
      const b = samples[Math.min(sampleCursor + 1, samples.length - 1)];
      const segLen = dist[Math.min(sampleCursor + 1, samples.length - 1)] - dist[sampleCursor];
      const u = segLen > 1e-6 ? clamp01((t - dist[sampleCursor]) / segLen) : 0;
      const x = a.x + (b.x - a.x) * u;
      const z = a.z + (b.z - a.z) * u;
      const onBridge = u < 0.5 ? a.bridge : b.bridge;
      const groundY = onBridge ? a.y + (b.y - a.y) * u : hf.heightAt(x, z);

      const heading = Math.atan2(b.z - a.z, b.x - a.x);
      const perpX = -Math.sin(heading);
      const perpZ = Math.cos(heading);

      for (const side of [-1, 1]) {
        if (idx >= CONE_CAP) break;
        this.posX[idx] = x + perpX * side * CONE_PERP_OFFSET;
        this.posY[idx] = groundY;
        this.posZ[idx] = z + perpZ * side * CONE_PERP_OFFSET;
        idx++;
      }
    }
    this.liveCount = idx;
  }

  /** Clears any placed cones (job removed/reset without a new placement following immediately). */
  clear(): void {
    this.placedEdgeId = null;
    this.liveCount = 0;
  }

  get edgeId(): number | null {
    return this.placedEdgeId;
  }

  /** `active` = this crew currently has a job in progress (same signal cones/stockpile/workers
   * all share). Positions never change here — only the shared fade scale. */
  update(dt: number, active: boolean): void {
    this.visibility = damp(this.visibility, active ? 1 : 0, 1 / FADE_DURATION, dt);
    const scale = easeOutCubic(clamp01(this.visibility));
    const visibleCount = active || this.visibility > 0.001 ? this.liveCount : 0;

    for (let i = 0; i < CONE_CAP; i++) {
      if (i >= visibleCount) {
        coneDummy.position.set(0, -9999, 0);
        coneDummy.scale.setScalar(0.001);
      } else {
        coneDummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
        coneDummy.scale.setScalar(Math.max(0.001, scale));
      }
      coneDummy.updateMatrix();
      this.mesh.setMatrixAt(i, coneDummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = scale > 0.001 && visibleCount > 0;
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
  // Depletion (Task 26 deliverable 4): the two gravel mounds shrink as the job progresses through
  // its stages; kept as their own group (separate from the pallet/crates, which stay full-size —
  // only the loose material pile visibly depletes) so `updateStockpileDepletion` can scale just them.
  moundGroup: THREE.Group;
}

function buildStockpile(): StockpileRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const gravelMat = flatMat(GRAVEL_COLOR);
  const palletMat = flatMat('#a9812f');
  const wrapMat = flatMat('#d8d0b0');
  materials.push(gravelMat, palletMat, wrapMat);

  const moundGroup = new THREE.Group();
  group.add(moundGroup);

  const mound = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.3, 10), gravelMat);
  mound.position.set(0, 0.65, 0);
  moundGroup.add(mound);

  const mound2 = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.8, 8), gravelMat);
  mound2.position.set(1.6, 0.4, 0.6);
  moundGroup.add(mound2);

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

  return { group, materials, moundGroup };
}

const WORKER_SKIN = '#c99a6f';

/** One worker figure: legs, hi-vis torso, head sphere, hardhat, arm — at most 6 primitives, the
 * budget shared with `buildSurveyor`'s figure. `armPivotY` names the arm's shoulder-height offset so
 * per-role animation (flagger wave, shovel lean) can rotate the same arm mesh about a sensible
 * pivot without each builder re-deriving it. Legs are a single fused box (not two) to leave a
 * primitive free for the hardhat brim while staying under budget: body(1) + head(1) + hardhat(1) +
 * torso(1) + arm(1) + legs(1) = 6.
 */
interface WorkerRig {
  group: THREE.Group;
  arm: THREE.Group; // pivots at the shoulder for wave/lean animation
  materials: THREE.MeshStandardMaterial[];
}

function buildWorkerFigure(): WorkerRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const skinMat = flatMat(WORKER_SKIN);
  const hiVisMat = flatMat(HI_VIS_ORANGE);
  const hatMat = flatMat(HARDHAT_COLOR);
  materials.push(skinMat, hiVisMat, hatMat);

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.62, 0.16), skinMat);
  legs.position.set(0, 0.31, 0);
  group.add(legs);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.24), hiVisMat);
  torso.position.set(0, 0.87, 0);
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), skinMat);
  head.position.set(0, 1.28, 0);
  group.add(head);

  const hardhat = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
  hardhat.position.set(0, 1.32, 0);
  group.add(hardhat);

  // Arm as a pivoted group so callers can rotate it at the shoulder for wave/lean animation.
  const arm = new THREE.Group();
  arm.position.set(0.17, 1.0, 0);
  group.add(arm);
  const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.1), skinMat);
  armMesh.position.set(0.18, 0, 0);
  arm.add(armMesh);

  return { group, arm, materials };
}

/** Motor grader rig (Task 26 deliverable 2): long frame, angled center blade, 6 wheels — 12
 * primitives total (frame, cab, engine hood, blade, 6 wheels, 2 blade-arm struts), comfortably
 * under the ≤12 budget. Pure theater: trails the truck's gravel drops with the blade lowered,
 * leveling the ribbon the sim already renders (no geometry change needed). */
function buildGrader(): VehicleRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(GRADER_COLOR);
  const cabMat = flatMat(CAB_COLOR);
  const wheelMat = flatMat(WHEEL_COLOR);
  const bladeMat = flatMat('#4a4a4a');
  materials.push(bodyMat, cabMat, wheelMat, bladeMat);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.35, 0.9), bodyMat);
  frame.position.set(0, 0.55, 0);
  body.add(frame);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 0.7), bodyMat);
  hood.position.set(1.5, 0.65, 0);
  body.add(hood);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), cabMat);
  cab.position.set(0.1, 1.05, 0);
  body.add(cab);

  // angled center blade, lowered near the ground just ahead of the front axle
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 1.8), bladeMat);
  blade.position.set(0.55, 0.28, 0);
  blade.rotation.y = THREE.MathUtils.degToRad(20); // angled to cast material to one side
  body.add(blade);

  const strutGeo = new THREE.BoxGeometry(0.6, 0.08, 0.08);
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(strutGeo, bodyMat);
    strut.position.set(0.25, 0.4, side * 0.3);
    strut.rotation.y = THREE.MathUtils.degToRad(20);
    body.add(strut);
  }

  const wheelGeo = wheelCylinder(0.4, 0.3);
  const wheels: WheelRef[] = [];
  // 6 wheels: 2 front (steerable in reality, decorative here), 4 rear in a tandem bogie
  for (const [x, zs] of [[1.4, [0.5, -0.5]], [-1.1, [0.5, -0.5]], [-1.6, [0.5, -0.5]]] as [number, number[]][]) {
    for (const z of zs) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(x, 0.4, z);
      body.add(wheel);
      wheels.push({ mesh: wheel, radius: 0.4 });
    }
  }

  const beaconMat = addBeacon(cab, 1.5);

  // The grader is pure render-side theater (like the roller) with no corresponding `VehicleKind` in
  // the sim's `construction:progress` contract — `kind` is never actually read anywhere in this
  // file (see PER_CREW_KINDS/stateFor, which only ever key off real per-crew vehicle kinds), so
  // reusing 'roller' here is just a harmless placeholder to satisfy VehicleRig's shape.
  return { kind: 'roller', group, body, beaconMat, wheels, materials };
}

const floodlightPoleDummy = new THREE.Object3D();
const floodlightHeadDummy = new THREE.Object3D();

/**
 * Task 37: floodlight TOWERS now stake down at fixed stations along a crew's job edge, exactly
 * like the T27 `ConePool` — placed once when the crew's job starts on a new edge and left
 * untouched (including through demolish jobs) for the job's whole duration, fading with the same
 * dressing signal as cones/stockpile/workers. Stations: both edge ends plus interior stations
 * targeting `FLOODLIGHT_SPACING` of arclength, alternating sides at `±FLOODLIGHT_PERP_OFFSET`,
 * capped at `FLOODLIGHT_CAP` towers (spacing widens automatically past the cap — same approach as
 * cones). Poles and heads are each a single InstancedMesh (2 draw calls total regardless of tower
 * count) with a shared emissive head material so night-gating stays a single intensity write.
 *
 * The LIGHT budget is unchanged: exactly one real THREE.SpotLight per crew, owned by the renderer
 * (not this pool) and repositioned to whichever tower is nearest the crew's current work front —
 * see `updateFloodlight`/`nearestTowerIndex`.
 */
class FloodlightTowerPool {
  readonly poleMesh: THREE.InstancedMesh;
  readonly headMesh: THREE.InstancedMesh;
  readonly headMat: THREE.MeshStandardMaterial;
  readonly poleMat: THREE.MeshStandardMaterial;
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly heading: Float32Array;
  private liveCount = 0;
  private visibility = 0;
  private placedEdgeId: number | null = null;

  constructor() {
    this.poleMat = flatMat('#4a4a4a');
    this.headMat = flatMat('#e8e8e0', FLOODLIGHT_COLOR);

    const poleGeo = new THREE.CylinderGeometry(0.18, 0.22, 6, 8);
    poleGeo.translate(0, 3, 0);
    this.poleMesh = new THREE.InstancedMesh(poleGeo, this.poleMat, FLOODLIGHT_CAP);
    this.poleMesh.count = FLOODLIGHT_CAP;
    this.poleMesh.frustumCulled = false;

    const headGeo = new THREE.BoxGeometry(1.1, 0.6, 0.5);
    headGeo.translate(0.3, 6.1, 0);
    headGeo.rotateZ(-0.35);
    this.headMesh = new THREE.InstancedMesh(headGeo, this.headMat, FLOODLIGHT_CAP);
    this.headMesh.count = FLOODLIGHT_CAP;
    this.headMesh.frustumCulled = false;

    this.posX = new Float32Array(FLOODLIGHT_CAP);
    this.posY = new Float32Array(FLOODLIGHT_CAP);
    this.posZ = new Float32Array(FLOODLIGHT_CAP);
    this.heading = new Float32Array(FLOODLIGHT_CAP);
  }

  /** Computes fixed tower stations along `samples` and uploads them once — idempotent per edge,
   * same one-shot-per-edge gate as `ConePool.place` (see `onProgress`).
   *
   * Bridge avoidance (finding fix): a full-height tower plants on the terrain/shore, not the deck
   * (the deck only extends to the rail, well short of `FLOODLIGHT_PERP_OFFSET`), so any station
   * whose nearest sample is bridge-flagged gets displaced along the edge to the nearest non-bridge
   * sample (searching both directions, preferring behind on ties). Displaced stations that land
   * within `FLOODLIGHT_STATION_MERGE_DIST` of another already-chosen station are dropped as
   * duplicates. If literally every sample on the edge is a bridge deck (a bridge spanning the
   * entire road, ends included), there's no shore to clamp to — place exactly two towers at the
   * two endpoint samples instead (the abutments), using deck y there since those samples remain
   * bridge samples.
   */
  place(edgeId: number, samples: RoadSample[], hf: Heightfield): void {
    this.placedEdgeId = edgeId;
    if (samples.length < 2) {
      this.liveCount = 0;
      return;
    }

    const dist = new Float32Array(samples.length);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      dist[i] = dist[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const total = dist[dist.length - 1];

    const allBridge = samples.every((s) => s.bridge);

    let idx = 0;
    if (allBridge) {
      // No shore anywhere on this edge — stake the two endpoint "abutment" samples regardless.
      const endpoints = samples.length === 2 ? [0, 1] : [0, samples.length - 1];
      for (const sIdx of endpoints) {
        if (idx >= FLOODLIGHT_CAP) break;
        const a = samples[Math.max(0, sIdx - 1)];
        const b = samples[Math.min(samples.length - 1, sIdx + 1)];
        const s = samples[sIdx];
        this.placeTowerAt(idx, s.x, s.z, s.y, a, b);
        idx++;
      }
      this.liveCount = idx;
      this.uploadMatrices();
      return;
    }

    let interiorCount = total > 0 ? Math.floor(total / FLOODLIGHT_SPACING) : 0;
    let stationCount = Math.max(2, interiorCount + 1);
    if (stationCount > FLOODLIGHT_CAP) stationCount = FLOODLIGHT_CAP;

    const stations: number[] = [];
    if (stationCount <= 2) {
      stations.push(0, total);
    } else {
      for (let i = 0; i < stationCount; i++) {
        stations.push((total * i) / (stationCount - 1));
      }
    }

    const chosenArclengths: number[] = [];
    let sampleCursor = 0;
    for (const t of stations) {
      if (idx >= FLOODLIGHT_CAP) break;
      while (sampleCursor < samples.length - 2 && dist[sampleCursor + 1] < t) sampleCursor++;
      const a = samples[sampleCursor];
      const b = samples[Math.min(sampleCursor + 1, samples.length - 1)];
      const segLen = dist[Math.min(sampleCursor + 1, samples.length - 1)] - dist[sampleCursor];
      const u = segLen > 1e-6 ? clamp01((t - dist[sampleCursor]) / segLen) : 0;
      const onBridge = u < 0.5 ? a.bridge : b.bridge;

      let placeIdx: number;
      let placeArc: number;
      if (!onBridge) {
        placeIdx = u < 0.5 ? sampleCursor : Math.min(sampleCursor + 1, samples.length - 1);
        placeArc = t;
      } else {
        // Station landed on a bridge deck — displace to the nearest non-bridge sample along the
        // edge, searching both directions and preferring "behind" (lower arclength) on ties.
        const nearestIdx = sampleCursor + (u < 0.5 ? 0 : 1);
        let behind = -1;
        for (let i = nearestIdx; i >= 0; i--) {
          if (!samples[i].bridge) { behind = i; break; }
        }
        let ahead = -1;
        for (let i = nearestIdx; i < samples.length; i++) {
          if (!samples[i].bridge) { ahead = i; break; }
        }
        if (behind < 0 && ahead < 0) {
          // Shouldn't happen (allBridge is handled above), but guard anyway.
          continue;
        }
        if (behind < 0) {
          placeIdx = ahead;
        } else if (ahead < 0) {
          placeIdx = behind;
        } else {
          const behindDist = dist[nearestIdx] - dist[behind];
          const aheadDist = dist[ahead] - dist[nearestIdx];
          placeIdx = aheadDist < behindDist ? ahead : behind; // ties favor behind
        }
        placeArc = dist[placeIdx];
      }

      // Drop duplicates: a displaced station that lands within FLOODLIGHT_STATION_MERGE_DIST of
      // an already-chosen station's arclength is redundant.
      if (chosenArclengths.some((c) => Math.abs(c - placeArc) < FLOODLIGHT_STATION_MERGE_DIST)) {
        continue;
      }

      const s = samples[placeIdx];
      const a2 = samples[Math.max(0, placeIdx - 1)];
      const b2 = samples[Math.min(samples.length - 1, placeIdx + 1)];
      this.placeTowerAt(idx, s.x, s.z, hf.heightAt(s.x, s.z), a2, b2);
      chosenArclengths.push(placeArc);
      idx++;
    }
    this.liveCount = idx;
    this.uploadMatrices();
  }

  /** Fills slot `idx` with a tower at world (x, groundY, z), offset laterally by
   * `FLOODLIGHT_PERP_OFFSET` and alternating sides per slot, using the heading derived from
   * neighbor samples `a`/`b` (same convention the old inline placement used). */
  private placeTowerAt(
    idx: number, x: number, z: number, groundY: number, a: RoadSample, b: RoadSample,
  ): void {
    const headingRad = Math.atan2(b.z - a.z, b.x - a.x);
    const perpX = -Math.sin(headingRad);
    const perpZ = Math.cos(headingRad);
    // alternate sides per station (unlike cones, which place a pair each station)
    const side = idx % 2 === 0 ? -1 : 1;

    this.posX[idx] = x + perpX * side * FLOODLIGHT_PERP_OFFSET;
    this.posY[idx] = groundY;
    this.posZ[idx] = z + perpZ * side * FLOODLIGHT_PERP_OFFSET;
    // face back toward the road so the emissive head reads as aimed down-road
    this.heading[idx] = headingRad + (side === -1 ? Math.PI / 2 : -Math.PI / 2);
  }

  /** Clears any placed towers (job removed/reset without a new placement following immediately). */
  clear(): void {
    this.placedEdgeId = null;
    this.liveCount = 0;
  }

  get edgeId(): number | null {
    return this.placedEdgeId;
  }

  get count(): number {
    return this.liveCount;
  }

  /** Current eased fade scale (0..1, `easeOutCubic`'d) — same signal driving the pole/head
   * InstancedMesh scale. Read by `FloodlightGroundLightPool` (Task 45) so ground pools/cones fade
   * with the exact same crew-dressing curve as the towers themselves, no separate easing state. */
  get fadeScale(): number {
    return this.curScale;
  }

  /** World position of tower `i` (valid for `i < count`). */
  towerPos(i: number): { x: number; y: number; z: number } {
    return { x: this.posX[i], y: this.posY[i], z: this.posZ[i] };
  }

  towerHeading(i: number): number {
    return this.heading[i];
  }

  /** Index of the tower nearest (x,z) among the placed, live towers; -1 if none are placed. */
  nearestTowerIndex(x: number, z: number): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.liveCount; i++) {
      const d = Math.hypot(this.posX[i] - x, this.posZ[i] - z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  private uploadMatrices(): void {
    for (let i = 0; i < FLOODLIGHT_CAP; i++) {
      if (i >= this.liveCount) {
        floodlightPoleDummy.position.set(0, -9999, 0);
        floodlightPoleDummy.scale.setScalar(0.001);
        floodlightPoleDummy.rotation.set(0, 0, 0);
        floodlightHeadDummy.position.set(0, -9999, 0);
        floodlightHeadDummy.scale.setScalar(0.001);
        floodlightHeadDummy.rotation.set(0, 0, 0);
      } else {
        floodlightPoleDummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
        floodlightPoleDummy.rotation.set(0, this.heading[i], 0);
        floodlightPoleDummy.scale.setScalar(this.curScale);
        floodlightHeadDummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
        floodlightHeadDummy.rotation.set(0, this.heading[i], 0);
        floodlightHeadDummy.scale.setScalar(this.curScale);
      }
      floodlightPoleDummy.updateMatrix();
      this.poleMesh.setMatrixAt(i, floodlightPoleDummy.matrix);
      floodlightHeadDummy.updateMatrix();
      this.headMesh.setMatrixAt(i, floodlightHeadDummy.matrix);
    }
    this.poleMesh.instanceMatrix.needsUpdate = true;
    this.headMesh.instanceMatrix.needsUpdate = true;
  }

  private curScale = 0.001; // last-uploaded scale, reused by uploadMatrices when only fade changes

  /** `active` = this crew currently has a job in progress (same shared signal as cones). Positions
   * never change here — only the shared fade scale, and (deliverable 3) the shared head material's
   * night-driven emissive intensity, set by the caller via `setHeadEmissive`. */
  update(dt: number, active: boolean): void {
    this.visibility = damp(this.visibility, active ? 1 : 0, 1 / FADE_DURATION, dt);
    const scale = Math.max(0.001, easeOutCubic(clamp01(this.visibility)));
    this.curScale = scale;
    const visibleCount = active || this.visibility > 0.001 ? this.liveCount : 0;
    this.uploadMatrices();
    this.poleMesh.visible = scale > 0.001 && visibleCount > 0;
    this.headMesh.visible = scale > 0.001 && visibleCount > 0;
  }

  /** Shared emissive intensity for every tower head in this crew (night-gated, cheap — one write
   * touches every placed tower since they share `headMat`). */
  setHeadEmissive(intensity: number): void {
    this.headMat.emissiveIntensity = intensity;
  }

  dispose(): void {
    this.poleMesh.geometry.dispose();
    this.headMesh.geometry.dispose();
    this.poleMat.dispose();
    this.headMat.dispose();
  }
}

/** Plate-compactor prop (Task 26 deliverable 2, second prop): a walk-behind rig of 5 primitives
 * (base plate, engine block, exhaust stub, handle arm, grip crossbar), well inside the workers'
 * ≤6-prim budget. Like the grader it's pure render-side theater with no VehicleKind in the sim's
 * event contract — it works the shoulder beside paint the sim has already laid, so nothing in
 * sim/queue.ts needs to know it exists. */
interface CompactorRig {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
}

function buildCompactor(): CompactorRig {
  const group = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const bodyMat = flatMat(COMPACTOR_COLOR);
  const plateMat = flatMat('#4a4a4a');
  const handleMat = flatMat('#2f2f2f');
  materials.push(bodyMat, plateMat, handleMat);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.6), plateMat);
  plate.position.y = 0.06;
  group.add(plate);

  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.45), bodyMat);
  engine.position.set(0.05, 0.34, 0);
  group.add(engine);

  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.22, 6), handleMat);
  exhaust.position.set(-0.12, 0.63, 0.12);
  group.add(exhaust);

  // handle arm rises up and back from the engine block (forward is +x, like every rig here)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.06, 0.06), handleMat);
  arm.position.set(-0.55, 0.62, 0);
  arm.rotation.z = -0.6;
  group.add(arm);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), handleMat);
  grip.position.set(-0.98, 0.9, 0);
  group.add(grip);

  return { group, materials };
}

const groundPoolDummy = new THREE.Object3D();
const groundConeDummy = new THREE.Object3D();
const upAxisFloodlight = new THREE.Vector3(0, 1, 0);

/**
 * Task 45: "visible cast light" per floodlight tower — the same cheap trick `carRenderer` uses for
 * headlights (an additive, depthWrite:false ground quad standing in for a real light's visible
 * footprint), applied to every placed-and-visible floodlight tower across ALL crews:
 *
 * - a warm ground "pool" ellipse quad flat on the terrain under the tower head, and
 * - a subtle downward "cone" quad running from the head down to the ground, oriented facing along
 *   the tower's heading (so it reads as a beam falling toward the road, matching the tower's
 *   down-road aim) — the vertical analogue of the car beam's horizontal trapezoid.
 *
 * Both are ONE InstancedMesh each (2 draw calls total, not per crew) since they're pure additive
 * decals sharing one material per mesh — exactly the `poleMesh`/`headMesh` "2 draw calls regardless
 * of tower count" pattern `FloodlightTowerPool` already established, just shared across crews too.
 * Capacity is bounded at `MAX_CREWS * FLOODLIGHT_CAP` instances each (3*24 = 72) so the draw-call
 * and vertex budget never depends on how many towers happen to be live.
 *
 * Visibility is driven per-instance by the OWNING crew's `floodlightVisibility` (night && job-
 * active, eased — see `updateFloodlight`) multiplied by that tower's own `FloodlightTowerPool`
 * fade scale (job-dressing fade — see `FloodlightTowerPool.update`), so a pool/cone only shows when
 * it's night AND the crew's towers are actually visible, easing in/out with both signals exactly
 * like the emissive head glow does. Instances beyond what's currently visible are parked off-screen
 * (scale 0) rather than toggling `mesh.count`, so partial visibility across crews (e.g. one crew's
 * job just started fading in while another's is fully faded out) composes correctly without needing
 * a compacting pass.
 */
class FloodlightGroundLightPool {
  readonly poolMesh: THREE.InstancedMesh;
  readonly coneMesh: THREE.InstancedMesh;
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly coneMat: THREE.MeshBasicMaterial;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;

    // Ground pool: a flat circular quad (CircleGeometry), laid flat (rotated to face up) and
    // lifted a hair above the terrain to avoid z-fighting.
    const poolGeo = new THREE.CircleGeometry(FLOODLIGHT_POOL_RADIUS, 16);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(0, 0.04, 0);
    this.poolMat = new THREE.MeshBasicMaterial({
      color: FLOODLIGHT_POOL_COLOR,
      toneMapped: false,
      transparent: true,
      opacity: FLOODLIGHT_POOL_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.poolMesh = new THREE.InstancedMesh(poolGeo, this.poolMat, capacity);
    this.poolMesh.frustumCulled = false;
    this.poolMesh.count = capacity;

    // Downward cone quad: authored in local space standing at the origin facing local +Z, narrow
    // at the top (head height, y=6.1 — matches the tower head's mounted height) and spreading to
    // FLOODLIGHT_POOL_RADIUS at the ground (y=0), same "flat trapezoid" trick as carRenderer's
    // beam quad but oriented vertically (falling down the tower instead of projecting ahead).
    const coneGeo = new THREE.BufferGeometry();
    const cp = new Float32Array([
      -FLOODLIGHT_CONE_TOP_RADIUS, 6.1, 0,
      FLOODLIGHT_CONE_TOP_RADIUS, 6.1, 0,
      FLOODLIGHT_POOL_RADIUS * 0.6, 0.05, 0,
      -FLOODLIGHT_POOL_RADIUS * 0.6, 0.05, 0,
    ]);
    coneGeo.setAttribute('position', new THREE.BufferAttribute(cp, 3));
    coneGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.coneMat = new THREE.MeshBasicMaterial({
      color: FLOODLIGHT_POOL_COLOR,
      toneMapped: false,
      transparent: true,
      opacity: FLOODLIGHT_CONE_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.coneMesh = new THREE.InstancedMesh(coneGeo, this.coneMat, capacity);
    this.coneMesh.frustumCulled = false;
    this.coneMesh.count = capacity;
  }

  /** Rebuilds every instance's transform from scratch each frame: iterates `towerPools` (one
   * `FloodlightTowerPool` per crew) and, for each live tower, writes a pool+cone instance scaled by
   * `nightAmount * tower.fadeScale` (parked at scale 0 when that product is ~0, or when capacity
   * runs out — silently dropped, same "cap-then-drop" behavior as the towers themselves). `heading`
   * orients the cone to fall toward the road, matching the tower's own facing. */
  update(towerPools: ReadonlyArray<{ pool: FloodlightTowerPool; nightAmount: number }>): void {
    let idx = 0;
    for (const { pool, nightAmount } of towerPools) {
      const fade = nightAmount * pool.fadeScale;
      if (fade <= 0.001) continue;
      for (let i = 0; i < pool.count; i++) {
        if (idx >= this.capacity) break;
        const p = pool.towerPos(i);
        const heading = pool.towerHeading(i);

        groundPoolDummy.position.set(p.x, p.y, p.z);
        groundPoolDummy.rotation.set(0, 0, 0);
        groundPoolDummy.scale.setScalar(fade);
        groundPoolDummy.updateMatrix();
        this.poolMesh.setMatrixAt(idx, groundPoolDummy.matrix);

        groundConeDummy.position.set(p.x, p.y, p.z);
        groundConeDummy.quaternion.setFromAxisAngle(upAxisFloodlight, heading);
        groundConeDummy.scale.setScalar(fade);
        groundConeDummy.updateMatrix();
        this.coneMesh.setMatrixAt(idx, groundConeDummy.matrix);

        idx++;
      }
    }
    for (; idx < this.capacity; idx++) {
      groundPoolDummy.position.set(0, -9999, 0);
      groundPoolDummy.rotation.set(0, 0, 0);
      groundPoolDummy.scale.setScalar(0.001);
      groundPoolDummy.updateMatrix();
      this.poolMesh.setMatrixAt(idx, groundPoolDummy.matrix);

      groundConeDummy.position.set(0, -9999, 0);
      groundConeDummy.rotation.set(0, 0, 0);
      groundConeDummy.scale.setScalar(0.001);
      groundConeDummy.updateMatrix();
      this.coneMesh.setMatrixAt(idx, groundConeDummy.matrix);
    }
    this.poolMesh.instanceMatrix.needsUpdate = true;
    this.coneMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.poolMesh.geometry.dispose();
    this.coneMesh.geometry.dispose();
    this.poolMat.dispose();
    this.coneMat.dispose();
  }
}

/**
 * Per-edge bridge-crane crossing state (Task 22 deliverable 3/4): tracks a single active gravel-
 * stage crossing of one bridge run at a time. `settledUpTo` is the edge-absolute arclength every
 * span up to (and including) has fully landed+bounced — this is exactly the value reported to
 * `roadRenderer.setBridgeMask` so the deck ribbon can never render ahead of it (deliverable 4).
 * `activeSpanIdx`/`phase`/`elapsed` drive the crane's own descend-and-settle animation for
 * whichever single span is currently in flight; at most one span animates at a time since the work
 * front only ever crosses spans in order.
 */
interface BridgeCrossing {
  edgeId: number;
  runFromDist: number;
  runToDist: number;
  settledUpTo: number; // edge-absolute arclength
  activeSpanIdx: number | null;
  phase: 'descending' | 'bouncing';
  elapsed: number;
  segmentFrom: number; // arclength bounds of the span currently animating
  segmentTo: number;
  cabYaw: number; // current damped slew yaw (radians, crane-local)
  demolish: boolean; // true if this crossing is being walked backward (reverse teardown)
  lastProgressAt: number; // this.clock as of the last progress event that touched this crossing
}

/**
 * Everything that's replicated per construction crew (Task 25): a full vehicle rig set (one
 * `VehicleRig` per non-crane `VehicleKind`, built once and hidden until that crew has a job), the
 * trailing roller, per-crew site dressing (cones + stockpile), and a per-crew floodlight. Built
 * `MAX_CREWS` times up front — "instancing not required, rigs are cheap primitives" per the
 * binding spec — and simply hidden (scale 0.001, `visible = false`) while a crew is idle.
 */
interface CrewSlot {
  rigs: Record<Exclude<VehicleKind, 'crane'>, VehicleRig>;
  states: Map<VehicleKind, VehicleState>;
  roller: VehicleState;
  lastSeenAt: Map<VehicleKind, number>;
  lastRollerSeenAt: number;
  dustTimer: number;
  steamTimer: number;
  cones: ConePool;
  stockpile: StockpileRig;
  stockpileVisibility: number;
  stockpileEdgeId: number | null;
  stockpileScale: number; // eased 0..1 depletion level (Task 26 deliverable 4), 1 = full mound

  // --- Task 37: floodlight towers -------------------------------------------------------------
  // Towers themselves are a fixed-station instanced pool, placed once per edge exactly like cones
  // (see FloodlightTowerPool). The LIGHT budget stays at exactly one real THREE.SpotLight per crew
  // — `floodlightLight` is owned here (not by the tower pool) and repositioned each frame to
  // whichever tower is nearest the crew's current work front, cross-fading (`floodlightLightMix`)
  // between the previous and new anchor tower over FLOODLIGHT_LIGHT_EASE seconds so it never pops
  // or visibly slides between towers.
  floodlightTowers: FloodlightTowerPool;
  floodlightLight: THREE.SpotLight;
  floodlightLightTarget: THREE.Object3D;
  floodlightVisibility: number; // night && job-active eased 0..1 (drives light intensity + head glow)
  floodlightAnchorTower: number; // index of the tower the light is currently at/easing toward, -1 = none
  floodlightLightMix: number; // 0..1 cross-fade progress from the previous anchor to the current one
  floodlightPrevPos: THREE.Vector3; // world pos of the previous anchor tower, for the cross-fade
  // scratch fields for updateSiteDressing -> cones.update handoff (avoids a per-frame allocation)
  dressingActive: boolean;
  dressingPos: THREE.Vector3;
  dressingHeading: number;

  // --- Task 26: worker figures --------------------------------------------------------------
  flagger: WorkerRig;
  spotter: WorkerRig;
  stockpileWorker: WorkerRig;
  workerVisibility: number; // eased 0..1, follows the same job-active signal as cones/stockpile
  flaggerPhase: number; // wave-cycle clock
  spotterPos: THREE.Vector3; // damped walk-step position (slower than the vehicle itself)
  spotterHeading: number;
  spotterStepPhase: number; // walk-bob clock, only advances while actually moving
  shovelPhase: number; // shovel-lean cycle clock
  shovelActive: boolean; // whether a lean cycle is currently playing
  shovelIdleGap: number; // seconds until the next roll for a new cycle

  // --- Task 26: motor grader -----------------------------------------------------------------
  grader: VehicleState;
  lastGraderSeenAt: number;
  graderScrapeTimer: number; // seconds until the next scrape one-shot (audio, driven from here)
  graderScrapeGap: number;

  // --- Task 26: plate compactor (Addendum B follow-up) ----------------------------------------
  compactor: CompactorRig;
  compactorVisibility: number; // eased 0..1 — dressing fade, gated on painted-stage liveness
  compactorPos: THREE.Vector3; // damped shoulder position trailing the liner
  compactorHeading: number;
  compactorTarget: THREE.Vector3; // last synthesized shoulder target (y = road sample height)
  compactorTargetHeading: number;
  compactorOnBridge: boolean; // trail point is on a bridge deck (use its y, not terrain height)
  compactorVibePhase: number; // plate-vibration bob clock, only advances while working
  lastCompactorSeenAt: number; // clock of the last painted-stage progress event (liveness)

  // --- Task 26: exhaust puffs ----------------------------------------------------------------
  exhaustTimer: Map<string, number>;

  // --- Task 33: break theater ----------------------------------------------------------------
  /** True while this crew's active job most recently reported `onBreak: true` (same idle-timeout
   * liveness pattern as every other per-crew "active" signal here — see `lastBreakSeenAt`). While
   * true: the excavator/roller/grader's cyclic animation is suppressed (they simply ease to a
   * neutral/idle pose, same code path as "not active"), and the flagger+spotter walk toward the
   * stockpile and idle-huddle there instead of their normal road-facing positions. */
  onBreak: boolean;
  lastBreakSeenAt: number;
}

// --- Quarry landmark (Task 34) -----------------------------------------------------------------
// One quarry per island, placed on the first road commit (see src/sim/quarry.ts). Rendered here
// (rather than a separate dedicated renderer) since it's a single static prop group with no
// per-frame articulation of its own — the only "animation" it needs (fade/pop-in) is the same
// scale-ease every other one-off prop in this file already uses, so a whole new renderer class
// would just duplicate that machinery for one instance.
const QUARRY_PIT_RADIUS = 9;
const QUARRY_PIT_DEPTH = 1.6;
const QUARRY_PAD_FLATTEN_RADIUS = 13; // terrain flatten pad, once at placement
const QUARRY_ROCK_COLOR = '#8f7a5c';
const QUARRY_ROCK_DARK_COLOR = '#6b5a44';
const QUARRY_STEEL_COLOR = '#7d8a8f';
const QUARRY_SILO_COLOR = '#c7c2b0';
const QUARRY_POP_DURATION = 1.4; // seconds, easeOutBack pop-in once terrain is flattened

/** Builds the quarry's static prop group: a sunken gravel pit (rim + floor), a conveyor (incline +
 * two support legs), and a silo (body + cone cap + base ring) — 8 primitives total, comfortably
 * under the ≤14 budget. One instance for the whole island (Task 34 deliverable 2). */
function buildQuarryProp(): THREE.Group {
  const group = new THREE.Group();

  const rockMat = flatMat(QUARRY_ROCK_COLOR);
  const rockDarkMat = flatMat(QUARRY_ROCK_DARK_COLOR);
  const steelMat = flatMat(QUARRY_STEEL_COLOR);
  const siloMat = flatMat(QUARRY_SILO_COLOR);

  // Pit rim: a flattened ring standing slightly proud of the sunken floor, reading as the lip of
  // the excavation. (1)
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(QUARRY_PIT_RADIUS * 0.72, QUARRY_PIT_RADIUS, 16),
    rockMat,
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.05;
  group.add(rim);

  // Pit floor: sunken disc, darker rock. (1)
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(QUARRY_PIT_RADIUS * 0.75, 16),
    rockDarkMat,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -QUARRY_PIT_DEPTH;
  group.add(floor);

  // Pit wall: a short open cone connecting rim to floor so the sunken look reads from any angle. (1)
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(QUARRY_PIT_RADIUS * 0.72, QUARRY_PIT_RADIUS * 0.75, QUARRY_PIT_DEPTH, 16, 1, true),
    rockDarkMat,
  );
  wall.position.y = -QUARRY_PIT_DEPTH / 2;
  group.add(wall);

  // Conveyor: an inclined belt box rising from the pit's edge toward the silo, on two support
  // legs. (3)
  const conveyor = new THREE.Group();
  conveyor.position.set(QUARRY_PIT_RADIUS * 0.55, 0, -QUARRY_PIT_RADIUS * 0.2);
  conveyor.rotation.y = Math.PI * 0.15;
  group.add(conveyor);

  const CONVEYOR_LENGTH = 9;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(CONVEYOR_LENGTH, 0.5, 1.3), steelMat);
  belt.position.set(CONVEYOR_LENGTH / 2, 2.2, 0);
  belt.rotation.z = THREE.MathUtils.degToRad(18);
  conveyor.add(belt);

  const legGeo = new THREE.BoxGeometry(0.35, 1, 0.35);
  const legFront = new THREE.Mesh(legGeo, steelMat);
  legFront.position.set(1.2, 1.05, 0);
  legFront.rotation.z = THREE.MathUtils.degToRad(18);
  conveyor.add(legFront);
  const legBack = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.2, 0.35), steelMat);
  legBack.position.set(CONVEYOR_LENGTH - 1.2, 3.4, 0);
  legBack.rotation.z = THREE.MathUtils.degToRad(18);
  conveyor.add(legBack);

  // Silo: cylindrical body, conical cap, small base ring — fed by the conveyor's upper end. (3)
  const silo = new THREE.Group();
  silo.position.set(
    conveyor.position.x + Math.cos(conveyor.rotation.y) * (CONVEYOR_LENGTH + 1),
    0,
    conveyor.position.z + Math.sin(conveyor.rotation.y) * (CONVEYOR_LENGTH + 1),
  );
  group.add(silo);

  const siloBody = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 6, 12), siloMat);
  siloBody.position.y = 3 + 4.6; // sits on top of the conveyor's high end, above the pit rim
  silo.add(siloBody);

  const siloCap = new THREE.Mesh(new THREE.ConeGeometry(1.8, 1.4, 12), rockMat);
  siloCap.position.y = 3 + 4.6 + 3 + 0.7;
  silo.add(siloCap);

  const siloBase = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 0.3, 12), steelMat);
  siloBase.position.y = 3 + 4.6 - 3 - 0.15;
  silo.add(siloBase);

  return group;
}

/**
 * Renders every active construction crew's vehicle for each in-progress job (Task 25: up to
 * `MAX_CREWS` concurrent crews, each with its own full rig set/dressing/floodlight — see
 * `CrewSlot`), plus the trailing roller during `paved` and dust/steam particle effects. Only the
 * vehicle(s) relevant to that crew's currently-streaming `construction:progress` events are shown,
 * damping toward the reported position/heading and fading in/out via scale so nothing pops.
 *
 * The bridge crane (Task 22) is the one deliberate exception to "everything is per-crew": it stays
 * a single shared rig, since bridges are rare and this keeps draw calls/complexity down. If two
 * crews are simultaneously mid-'gravel' inside a bridge run, the second crew's spans still settle
 * (the sim-side masking/settling logic is per-edge, not per-crane), it just doesn't get its own
 * crane visual while the first crew's crossing is animating.
 */
export class ConstructionRenderer {
  private crews: CrewSlot[] = [];

  private dustPool: ParticlePool;
  private steamPool: ParticlePool;
  private gravelPool: ParticlePool;
  private exhaustPool: ParticlePool; // Task 26 deliverable 3: shared across crews (positions carry crew implicitly)
  private tireMarks: TireMarkPool;
  private stakes: StakePool;

  private clock = 0;
  private readonly IDLE_TIMEOUT = 0.2; // seconds without a progress event => job considered done

  // Shared crane rig (see class doc above): stationed by whichever crew currently owns the one
  // active forward bridge crossing (see updateBridgeCrossings).
  private craneRig: VehicleRig;
  private craneState: VehicleState;

  // Bridge construction theater (Task 22): at most one active crossing per edge (a bridge run
  // being actively crossed by 'gravel'-stage progress right now); cleared once the crossing's
  // owning job goes idle/moves past the run so the crane can fade out and be reused elsewhere.
  private bridgeCrossings: Map<number, BridgeCrossing> = new Map();
  private craneSeenAt = -Infinity;
  private craneSegment: THREE.Mesh;
  private craneSegmentMat: THREE.MeshStandardMaterial;

  // --- Quarry landmark (Task 34) -------------------------------------------------------------
  private quarryGroup: THREE.Group;
  private quarryPlacement: QuarryPlacement | null = null; // null until placed; shuttles fall back
                                                            // to the pre-Task-34 "toward map edge" behavior
  private quarryPopElapsed = 0; // seconds since placement, drives the pop-in ease
  private quarryPopping = false;

  // --- Task 45: visible cast light per floodlight tower --------------------------------------
  // One shared pool across ALL crews (not per-crew) — see FloodlightGroundLightPool's class doc.
  private floodlightGroundLights: FloodlightGroundLightPool;
  // Scratch array reused every frame by the ground-light update call below, avoiding a fresh
  // array/object allocation per rendered frame (MAX_CREWS entries, mutated in place).
  private floodlightGroundLightScratch: { pool: FloodlightTowerPool; nightAmount: number }[] = [];

  constructor(
    private scene: THREE.Scene,
    bus: EventBus,
    private graph: RoadGraph,
    private hf: Heightfield,
    private roadRenderer: RoadRenderer,
    quarry?: QuarrySim,
  ) {
    for (let crew = 0; crew < MAX_CREWS; crew++) {
      this.crews.push(this.makeCrewSlot());
    }

    this.quarryGroup = buildQuarryProp();
    this.quarryGroup.visible = false;
    this.quarryGroup.scale.setScalar(0.001);
    this.scene.add(this.quarryGroup);
    // An already-placed quarry (restored save, or a QuarrySim constructed and placed before this
    // renderer — shouldn't normally happen given main.ts's construction order, but stay defensive)
    // shows immediately at full scale, no pop-in.
    if (quarry?.placement) this.placeQuarryProp(quarry.placement, false);
    bus.on('quarry:placed', (e) => this.placeQuarryProp(e, true));

    this.craneRig = buildCrane();
    this.craneRig.group.visible = false;
    this.craneRig.group.scale.setScalar(0.001);
    this.scene.add(this.craneRig.group);
    this.craneState = this.makeState(this.craneRig);

    this.dustPool = new ParticlePool(DUST_POOL_SIZE, DUST_SIZE, DUST_COLOR, DUST_LIFETIME);
    this.steamPool = new ParticlePool(STEAM_POOL_SIZE, STEAM_SIZE, STEAM_COLOR, STEAM_LIFETIME);
    this.gravelPool = new ParticlePool(80, 1.0, GRAVEL_COLOR, 0.9);
    this.exhaustPool = new ParticlePool(EXHAUST_POOL_SIZE, EXHAUST_SIZE, EXHAUST_COLOR, EXHAUST_LIFETIME);
    this.tireMarks = new TireMarkPool(TIRE_MARK_POOL_SIZE);
    this.stakes = new StakePool(STAKE_POOL_SIZE);
    this.scene.add(this.dustPool.points);
    this.scene.add(this.steamPool.points);
    this.scene.add(this.gravelPool.points);
    this.scene.add(this.exhaustPool.points);
    this.scene.add(this.tireMarks.mesh);
    this.scene.add(this.stakes.mesh);

    const craneSegmentParts = buildCraneSegment();
    this.craneSegment = craneSegmentParts.mesh;
    this.craneSegmentMat = craneSegmentParts.mat;
    this.scene.add(this.craneSegment);

    this.floodlightGroundLights = new FloodlightGroundLightPool(MAX_CREWS * FLOODLIGHT_CAP);
    this.scene.add(this.floodlightGroundLights.poolMesh);
    this.scene.add(this.floodlightGroundLights.coneMesh);
    for (const slot of this.crews) {
      this.floodlightGroundLightScratch.push({ pool: slot.floodlightTowers, nightAmount: 0 });
    }

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

  /** Places the quarry prop group at its sim-decided position/rotation, flattens a terrain pad
   * once (Task 34 deliverable 2: "terrain-flattened pad, flattenCircle once at placement"), and
   * either pops it in (`animate: true`, a live first-road placement) or shows it immediately at
   * full scale (`animate: false`, restoring an already-known placement from a save). */
  private placeQuarryProp(placement: QuarryPlacement, animate: boolean): void {
    this.quarryPlacement = placement;
    const y = this.hf.heightAt(placement.x, placement.z);
    this.hf.flattenCircle(placement.x, placement.z, y, QUARRY_PAD_FLATTEN_RADIUS);
    this.quarryGroup.position.set(placement.x, y, placement.z);
    this.quarryGroup.rotation.y = placement.rot;
    this.quarryGroup.visible = true;
    if (animate) {
      this.quarryPopping = true;
      this.quarryPopElapsed = 0;
      this.quarryGroup.scale.setScalar(0.001);
    } else {
      this.quarryPopping = false;
      this.quarryGroup.scale.setScalar(1);
    }
  }

  /** The quarry's world position, or `null` if none has been placed yet (no road ever committed).
   * Read by the truck shuttle theater so trips can head toward it instead of the map edge. */
  get quarryPosition(): { x: number; z: number } | null {
    return this.quarryPlacement ? { x: this.quarryPlacement.x, z: this.quarryPlacement.z } : null;
  }

  /** Builds one crew's full rig set + site dressing + floodlight, adds everything to the scene
   * hidden, and returns the assembled `CrewSlot`. */
  private makeCrewSlot(): CrewSlot {
    const rigs = {
      excavator: buildExcavator(),
      truck: buildTruck(),
      paver: buildPaver(),
      roller: buildRoller(),
      liner: buildLiner(),
      surveyor: buildSurveyor(),
    };
    for (const kind of PER_CREW_KINDS) {
      const rig = rigs[kind];
      rig.group.visible = false;
      rig.group.scale.setScalar(0.001);
      this.scene.add(rig.group);
    }

    const cones = new ConePool();
    this.scene.add(cones.mesh);

    const stockpile = buildStockpile();
    stockpile.group.visible = false;
    stockpile.group.scale.setScalar(0.001);
    this.scene.add(stockpile.group);

    // Floodlight towers (Task 37): fixed-station instanced pool (2 draw calls, poles + heads),
    // placed once per edge exactly like cones — see `onProgress`/`updateSiteDressing`. The single
    // budgeted SpotLight per crew is built here directly (not by the pool) since it's repositioned
    // to whichever tower is nearest the work front rather than belonging to any one tower.
    const floodlightTowers = new FloodlightTowerPool();
    this.scene.add(floodlightTowers.poleMesh);
    this.scene.add(floodlightTowers.headMesh);

    const floodlightLight = new THREE.SpotLight(
      FLOODLIGHT_COLOR, 0, 40, THREE.MathUtils.degToRad(35), 0.4, 1.2,
    );
    floodlightLight.castShadow = false; // shadowless — Zen perf constraint, no extra shadow-map draw calls
    floodlightLight.visible = false;
    const floodlightLightTarget = new THREE.Object3D();
    floodlightLight.target = floodlightLightTarget;
    this.scene.add(floodlightLight);
    this.scene.add(floodlightLightTarget);

    // 'roller' is never itself a target `vehicle` on a progress event (queue.ts only ever emits
    // excavator/truck/paver/liner) — it only trails the paver during 'paved', so its state is
    // driven exclusively by the synthetic trailing-position logic in onProgress()/update() below.
    const roller = this.makeState(rigs.roller);

    // Worker figures (Task 26 deliverable 1): built once per crew, hidden until the crew has a job,
    // faded with the same dressing signal as cones/stockpile.
    const flagger = buildWorkerFigure();
    const spotter = buildWorkerFigure();
    const stockpileWorker = buildWorkerFigure();
    for (const w of [flagger, spotter, stockpileWorker]) {
      w.group.visible = false;
      w.group.scale.setScalar(0.001);
      this.scene.add(w.group);
    }

    // Motor grader (deliverable 2): a standalone rig+state pair per crew, same pattern as `roller`
    // above — pure render theater synthesized from the truck's gravel-stage progress, no
    // corresponding VehicleKind in the sim's event contract.
    const graderRig = buildGrader();
    graderRig.group.visible = false;
    graderRig.group.scale.setScalar(0.001);
    this.scene.add(graderRig.group);
    const grader = this.makeState(graderRig);

    // Plate compactor (deliverable 2, second prop): standalone per-crew prop like the grader,
    // parked near fresh paint — built once, hidden until this crew's job reaches painting.
    const compactor = buildCompactor();
    compactor.group.visible = false;
    compactor.group.scale.setScalar(0.001);
    this.scene.add(compactor.group);

    return {
      rigs,
      states: new Map(),
      roller,
      lastSeenAt: new Map(),
      lastRollerSeenAt: -Infinity,
      dustTimer: 0,
      steamTimer: 0,
      cones,
      stockpile,
      stockpileVisibility: 0,
      stockpileEdgeId: null,
      stockpileScale: 1,
      floodlightTowers,
      floodlightLight,
      floodlightLightTarget,
      floodlightVisibility: 0,
      floodlightAnchorTower: -1,
      floodlightLightMix: 1,
      floodlightPrevPos: new THREE.Vector3(),
      dressingActive: false,
      dressingPos: new THREE.Vector3(),
      dressingHeading: 0,
      flagger,
      spotter,
      stockpileWorker,
      workerVisibility: 0,
      flaggerPhase: 0,
      spotterPos: new THREE.Vector3(),
      spotterHeading: 0,
      spotterStepPhase: 0,
      shovelPhase: 0,
      shovelActive: false,
      shovelIdleGap: SHOVEL_IDLE_GAP_MIN,
      grader,
      lastGraderSeenAt: -Infinity,
      graderScrapeTimer: 0,
      graderScrapeGap: 6 + Math.random() * (10 - 6),
      compactor,
      compactorVisibility: 0,
      compactorPos: new THREE.Vector3(),
      compactorHeading: 0,
      compactorTarget: new THREE.Vector3(),
      compactorTargetHeading: 0,
      compactorOnBridge: false,
      compactorVibePhase: 0,
      lastCompactorSeenAt: -Infinity,
      exhaustTimer: new Map(),
      onBreak: false,
      lastBreakSeenAt: -Infinity,
    };
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

  /** Looks up (lazily creating) crew `crew`'s VehicleState for `kind`. `kind` must be one of the
   * per-crew kinds (not 'crane' — see `this.craneState`). */
  private stateFor(crew: number, kind: Exclude<VehicleKind, 'crane'>): VehicleState {
    const slot = this.crews[crew];
    let s = slot.states.get(kind);
    if (!s) {
      s = this.makeState(slot.rigs[kind]);
      slot.states.set(kind, s);
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
        // Sample terrain height at the spawn XZ rather than reusing the destination's Y — the
        // spawn point is SPAWN_DISTANCE away and can sit at a very different elevation.
        const spawnY = this.hf.heightAt(spawnX, spawnZ);
        state.curPos.set(spawnX, spawnY, spawnZ);
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
    crew: number;
    onBreak: boolean;
  }): void {
    // crew: -1 is the sim's "no live crew" sentinel (synchronous instant-remove / save-restore
    // sync emits — see queue.ts) and never carries a real `construction:progress` event (only
    // `construction:stage` uses it), but guard anyway rather than indexing crews[-1].
    if (e.crew < 0 || e.crew >= this.crews.length) return;
    const slot = this.crews[e.crew];

    // Task 33: break theater liveness — same idle-timeout pattern as every other per-crew signal
    // here (see `updateCrew`'s `active` checks): a break "reads" as ongoing for IDLE_TIMEOUT past
    // the last onBreak:true event, so a single dropped/late frame can't cause a visible flicker
    // back to normal work pose mid-break.
    if (e.onBreak) slot.lastBreakSeenAt = this.clock;

    const state = this.stateFor(e.crew, e.vehicle as Exclude<VehicleKind, 'crane'>);
    // Task 36 concurrent-front pipeline finding (Groundwork stutter, Task 46): the truck kind is
    // shared across three roles that can all be live on the SAME crew at once — an idle anchor
    // beside the excavator during 'graded' (may be mid-shuttle, see updateTruckShuttle), the real
    // hauling vehicle during 'gravel' (THIS generic handler, `e.vehicle === 'truck'`), and the
    // paver-dock anchor during 'paved' (see the dedicated branch below). Without this gate, a real
    // 'gravel'-stage progress event (this crew's later front already hauling gravel) would
    // unconditionally overwrite targetPos here, fighting updateTruckShuttle's own targetPos writes
    // every sim tick and producing an unbounded tug-of-war — the truck visibly gliding toward the
    // gravel front's position instead of driving off to "dump" its spoil, worse the more sim ticks
    // batch into one rendered frame at higher timeScale. Every other vehicle kind has no shuttle
    // concept, so the gate only applies to 'truck'.
    if (e.vehicle !== 'truck' || state.shuttlePhase === 'idle') {
      this.applyProgressTarget(state, e.edgeId, new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), e.heading);
    } else {
      state.currentEdgeId = e.edgeId;
    }
    slot.lastSeenAt.set(e.vehicle, this.clock);
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
    // Per-crew (Task 25): each crew's own stockpile marks ITS OWN current job's start point.
    if (edge && slot.stockpileEdgeId !== e.edgeId) {
      slot.stockpileEdgeId = e.edgeId;
      const start = edge.samples[0];
      slot.stockpile.group.position.set(start.x, start.y, start.z);
      slot.stockpile.group.rotation.y = -e.heading;
    }

    // Static work-zone cones (Addendum C, Task 27): fixed positions computed ONCE from the
    // edge's samples the moment this crew's job starts on it (same one-shot-per-edge gate as the
    // stockpile above), then left exactly where placed for the job's entire duration — including
    // demolish jobs, which get the same treatment since this only keys off edgeId, not direction.
    if (edge && slot.cones.edgeId !== e.edgeId) {
      slot.cones.place(e.edgeId, edge.samples, this.hf);
    }

    // Static floodlight towers (Task 37): same fixed-station, one-shot-per-edge placement as
    // cones above — towers stay exactly where placed for the job's whole duration (including
    // demolish jobs). Resetting the placement also drops the light's current anchor so it picks a
    // fresh nearest tower next frame instead of easing from a now-stale index.
    if (edge && slot.floodlightTowers.edgeId !== e.edgeId) {
      slot.floodlightTowers.place(e.edgeId, edge.samples, this.hf);
      slot.floodlightAnchorTower = -1;
      slot.floodlightLightMix = 1;
    }

    // Survey stakes (deliverable 2): the surveyor plants a real stake every STAKE_SPACING as it
    // passes; grading later sweeps them away as the work front overtakes the surveyed line.
    // Stakes are a shared pool keyed by edgeId (not crew) — two crews never share an edge, so no
    // cross-crew collision is possible here.
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
      this.applyProgressTarget(slot.roller, e.edgeId, new THREE.Vector3(pos.x, pos.y, pos.z), rollerHeading);
      slot.lastRollerSeenAt = this.clock;
      slot.roller.stage = 'paved';
      slot.roller.demolish = e.demolish;
      slot.roller.onBridge = nearestSampleBridge(edge.samples, rollerT);
    }

    // Truck shuttle theater (deliverable 3): during 'graded' and 'paved' stages queue.ts never
    // reports a `vehicle: 'truck'` progress event (only 'gravel' does), so the truck's presence
    // then is purely synthesized here from the excavator's/paver's own progress — exactly the
    // same synthesis pattern used for the roller above. Sim timing (job.t/stage transitions) is
    // completely untouched; this only ever feeds the truck's *cosmetic* target position.
    if (e.stage === 'graded' && !e.demolish && edge) {
      const truckState = this.stateFor(e.crew, 'truck');
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
      slot.lastSeenAt.set('truck', this.clock);
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
      const truckState = this.stateFor(e.crew, 'truck');
      // dock nose-to-hopper just behind the paver (paver travel direction is +heading, hopper is
      // at its front, so the truck backs up to it from behind).
      const dockDist = 3.2;
      const tx = e.pos.x - Math.cos(e.heading) * dockDist;
      const tz = e.pos.z - Math.sin(e.heading) * dockDist;
      const ty = this.hf.heightAt(tx, tz);
      // Same shuttlePhase === 'idle' gate as the 'graded' branch above (Task 36 concurrent-front
      // pipeline finding): a fresh grading front's truck can still be mid-shuttle (departing/away/
      // returning to "dump" its spoil) on this SAME crew while the paved front is already active
      // further back along the edge. Without this gate, every paved-stage progress tick called
      // applyProgressTarget unconditionally, overwriting the shuttling truck's targetPos back to
      // the paver dock position — fighting updateTruckShuttle's own targetPos writes (see there)
      // every single sim tick and producing an unbounded tug-of-war (the truck visibly gliding
      // toward the dock, then snapping back toward its shuttle destination, worse the more sim
      // ticks batch into one rendered frame at higher timeScale). While not idle, only keep
      // currentEdgeId in sync so a later real idle sighting on this edge is still treated as the
      // "same session" rather than a same-kind handoff.
      if (truckState.shuttlePhase === 'idle') {
        this.applyProgressTarget(truckState, e.edgeId, new THREE.Vector3(tx, ty, tz), e.heading);
      } else {
        truckState.currentEdgeId = e.edgeId;
      }
      slot.lastSeenAt.set('truck', this.clock);
      truckState.stage = 'paved';
      truckState.demolish = false;
      truckState.onBridge = nearestSampleBridge(edge.samples, e.t);
    }

    // Motor grader (Task 26 deliverable 2): during 'gravel' stage the reported `vehicle` IS the
    // truck (see queue.ts's STAGE_VEHICLE), so the grader is purely synthesized here trailing the
    // truck's own work-front position by GRADER_TRAIL_DISTANCE — same trailing-position pattern as
    // the paved-stage roller above. Reverse (demolish) gravel work doesn't deposit anything, so the
    // grader has nothing to level; it only appears for forward gravel work.
    if (e.stage === 'gravel' && !e.demolish && edge) {
      const graderT = Math.max(0, e.t - GRADER_TRAIL_DISTANCE);
      const { pos, heading } = sampleAt(edge.samples, graderT);
      this.applyProgressTarget(slot.grader, e.edgeId, new THREE.Vector3(pos.x, pos.y, pos.z), heading);
      slot.lastGraderSeenAt = this.clock;
      slot.grader.stage = 'gravel';
      slot.grader.demolish = false;
      slot.grader.onBridge = nearestSampleBridge(edge.samples, graderT);
    }

    // Plate compactor (Task 26 deliverable 2, second prop): during 'painted' work the reported
    // vehicle IS the liner, so the compactor is synthesized trailing its nozzle on the shoulder
    // beside the dashes it just painted — same render-only synthesis as the grader above.
    // Demolish work strips paint rather than laying it, so there's nothing fresh to work beside.
    if (e.stage === 'painted' && !e.demolish && edge) {
      const compactorT = Math.max(0, e.t - COMPACTOR_TRAIL_DISTANCE);
      const { pos, heading } = sampleAt(edge.samples, compactorT);
      const onBridge = nearestSampleBridge(edge.samples, compactorT);
      // over water there's no shoulder to park on — pull it in onto the deck edge instead
      const side = onBridge ? COMPACTOR_BRIDGE_SIDE_OFFSET : COMPACTOR_SIDE_OFFSET;
      slot.compactorTarget.set(
        pos.x - Math.sin(heading) * side,
        pos.y,
        pos.z + Math.cos(heading) * side,
      );
      slot.compactorTargetHeading = heading;
      slot.compactorOnBridge = onBridge;
      slot.lastCompactorSeenAt = this.clock;
    }

    // Bridge construction theater (deliverable 3/4): 'gravel'-stage progress crossing a bridge run
    // stations the crane and lowers deck segments span-by-span; the deck ribbon stays masked (see
    // roadRenderer.setBridgeMask) until each span settles. Demolition's reverse teardown is a
    // simple fade (no crane) per the binding spec, handled by `updateBridgeCrossings`'s recede path.
    // The crane rig itself is shared globally (see class doc) — `bridgeCrossings` stays keyed by
    // edgeId only; `updateBridgeCrossings` picks one crossing per frame to actually show the crane
    // on if more than one edge happens to be mid-crossing at once.
    if (e.stage === 'gravel' && edge) {
      this.onGravelBridgeProgress(e.edgeId, edge, e.t, e.demolish);
    }
  }

  /**
   * Advances (or starts/ends) this edge's `BridgeCrossing` in response to a 'gravel'-stage
   * progress event. Only meaningful while `t` is actually within one of the edge's bridge runs —
   * everywhere else on the edge, gravel work proceeds exactly as before Task 22 (no crane, no
   * masking) and any existing crossing for this edge is torn down so its mask/state don't linger.
   */
  private onGravelBridgeProgress(edgeId: number, edge: { samples: Parameters<typeof getBridgeRunInfo>[0] }, t: number, demolish: boolean): void {
    const runs = getBridgeRunInfo(edge.samples);
    const run = runs.find((r) => t >= r.fromDist - 0.01 && t <= r.toDist + 0.01);

    if (!run) {
      // Work front isn't currently inside any bridge run on this edge — nothing to animate. Leave
      // any existing (now-finished) crossing's mask exactly where it settled; `updateBridgeCrossings`
      // clears it once the crossing goes idle for IDLE_TIMEOUT, same liveness pattern as every
      // other vehicle kind in this file.
      return;
    }

    let crossing = this.bridgeCrossings.get(edgeId);
    if (!crossing || crossing.runFromDist !== run.fromDist) {
      // Fresh crossing of this run (first time we've seen 'gravel' progress land inside it, or a
      // different run on a multi-bridge edge): start masking from the run's own beginning (or, for
      // a demolish walking backward INTO this run from the far end, from the run's own end — see
      // below) rather than wherever `t` happens to be, so there's never a gap for spans skipped
      // between "job started" and "the first progress event we happened to observe."
      crossing = {
        edgeId,
        runFromDist: run.fromDist,
        runToDist: run.toDist,
        settledUpTo: demolish ? run.toDist : run.fromDist,
        activeSpanIdx: null,
        phase: 'descending',
        elapsed: 0,
        segmentFrom: run.fromDist,
        segmentTo: run.fromDist,
        cabYaw: 0,
        demolish,
        lastProgressAt: this.clock,
      };
      this.bridgeCrossings.set(edgeId, crossing);
      this.roadRenderer.setBridgeMask(edgeId, crossing.settledUpTo);
    }
    crossing.demolish = demolish;
    crossing.lastProgressAt = this.clock;
    // The crane rig itself only ever appears for the forward (build) direction — reverse teardown
    // is a simple fade per the binding spec, no crane required — so liveness for 'crane' the
    // VehicleKind is refreshed here only in the non-demolish case.
    if (!demolish) this.craneSeenAt = this.clock;

    if (demolish) {
      // Reverse teardown (deliverable 6): simple recede, no crane — settledUpTo (here read as "not
      // yet torn down past this point") tracks the receding work front directly, one-to-one, with
      // no descend/bounce animation. `updateBridgeCrossings` drives the actual fade-down visuals.
      crossing.settledUpTo = Math.max(run.fromDist, Math.min(run.toDist, t));
      this.roadRenderer.setBridgeMask(edgeId, crossing.settledUpTo);
      return;
    }

    const spanIdx = Math.max(0, Math.floor((t - run.fromDist) / BRIDGE_SPAN_LENGTH));
    const spanFrom = run.fromDist + spanIdx * BRIDGE_SPAN_LENGTH;
    const spanTo = Math.min(run.toDist, spanFrom + BRIDGE_SPAN_LENGTH);

    if (crossing.activeSpanIdx === null || crossing.activeSpanIdx !== spanIdx) {
      // Work front has advanced into a new span: kick off that span's descent. If a previous span
      // was still mid-animation (shouldn't normally happen at 8u/s vs. a 1.5s+bounce descent, but
      // the work front's speed is a sim constant we don't control), snap it straight to settled
      // first so we never leave two segments animating at once.
      if (crossing.activeSpanIdx !== null) {
        this.settleBridgeSpan(crossing);
      }
      crossing.activeSpanIdx = spanIdx;
      crossing.segmentFrom = spanFrom;
      crossing.segmentTo = spanTo;
      crossing.phase = 'descending';
      crossing.elapsed = 0;
    }
  }

  /** Immediately finalizes whichever span is currently animating on `crossing` (used both by the
   * normal descend->bounce completion in `updateBridgeCrossings` and as a safety valve if the work
   * front races ahead of the crane's own animation timing). */
  private settleBridgeSpan(crossing: BridgeCrossing): void {
    if (crossing.activeSpanIdx === null) return;
    crossing.settledUpTo = Math.max(crossing.settledUpTo, crossing.segmentTo);
    this.roadRenderer.setBridgeMask(crossing.edgeId, crossing.settledUpTo);
    this.roadRenderer.markSpanSettled(crossing.edgeId, crossing.runFromDist, crossing.activeSpanIdx);
    crossing.activeSpanIdx = null;
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
    state.curPos.z = damp(state.curPos.z, state.targetPos.z, POS_LAMBDA, dt);

    // Y damping: while working at the road (or on a bridge), targetPos.y is already the correct
    // road/deck sample, so damp straight toward it as before. But during a long drive-in approach
    // (fresh arrival / far-relocate spawn, see applyProgressTarget) the target is still the distant
    // work-front position — damping straight toward its Y across 60u of varied terrain can float
    // the rig over valleys or bury it in hills. So while still far from the target horizontally,
    // follow the terrain under the vehicle's *current* XZ instead; only blend onto the target's own
    // Y once close enough that "the road's grade" and "the terrain" are effectively the same thing.
    const dxTarget = state.targetPos.x - state.curPos.x;
    const dzTarget = state.targetPos.z - state.curPos.z;
    const horizDistToTarget = Math.sqrt(dxTarget * dxTarget + dzTarget * dzTarget);
    const yGoal = (!state.onBridge && horizDistToTarget > APPROACH_TERRAIN_EPS)
      ? this.hf.heightAt(state.curPos.x, state.curPos.z)
      : state.targetPos.y;
    state.curPos.y = damp(state.curPos.y, yGoal, POS_LAMBDA, dt);

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
        // Sample terrain height at the spawn XZ rather than reusing the pending destination's Y —
        // see the identical fix at the fresh-arrival spawn site above.
        const spawnY = this.hf.heightAt(spawnX, spawnZ);
        state.curPos.set(spawnX, spawnY, spawnZ);
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

  /**
   * Advances every crew's vehicles/dressing/floodlight independently (Task 25), then the shared
   * systems (crane theater, particle pools, tire marks, stakes) once globally.
   *
   * `timeScale` (Task 46, Groundwork stutter fix): the HUD speed control (1x/4x/16x) batches up to
   * `Math.ceil(8 * timeScale)` fixed sim steps into a single rendered frame (see Loop), so
   * `construction:progress` events can move a vehicle's `targetPos`/`targetHeading` by many
   * sim-seconds' worth of travel between one rendered frame and the next. `stepVehicle`'s
   * position/heading damping (POS_LAMBDA/ROT_LAMBDA) previously chased that target using plain
   * wall-clock `dt`, so the damped position could never catch up before the NEXT batch moved the
   * target again — a sawtooth that got worse, not better, at higher speed (see task-46-report.md).
   * `stepDt` below scales just that damping's effective dt by `timeScale`, so it tracks how much
   * sim-time actually elapsed this rendered frame. Every OTHER per-frame timer in this class
   * (IDLE_TIMEOUT liveness, break theater, dust/steam intervals, dig-cycle phase, bed-tip cycle)
   * stays on plain wall-clock `dt` — those are real-time animation/liveness constants, not
   * sim-progress catch-up, and scaling them too would break IDLE_TIMEOUT's very premise (a single
   * rendered frame's clock advance would then regularly exceed the 0.2s idle window on its own).
   */
  update(dt: number, night: boolean, timeScale = 1): void {
    this.clock += dt;
    const stepDt = dt * Math.max(1, timeScale);

    if (this.quarryPopping) {
      this.quarryPopElapsed += dt;
      const t = clamp01(this.quarryPopElapsed / QUARRY_POP_DURATION);
      this.quarryGroup.scale.setScalar(Math.max(0.001, easeOutBack(t)));
      if (t >= 1) this.quarryPopping = false;
    }

    // Bridge crane theater (Task 22) is stepped before the generic per-kind loop below so its
    // `applyProgressTarget`/liveness bookkeeping (synthesized here, same pattern as the truck
    // shuttle/roller — queue.ts never emits a real `vehicle: 'crane'` progress event) is in place
    // before `stepVehicle` for the crane runs this same frame.
    this.updateBridgeCrossings(dt);
    const craneActive = this.clock - this.craneSeenAt <= this.IDLE_TIMEOUT;
    this.stepVehicle(this.craneState, stepDt, craneActive);
    this.craneRig.beaconMat.emissiveIntensity = this.beaconIntensity(night);

    for (let crew = 0; crew < this.crews.length; crew++) {
      this.updateCrew(crew, dt, night, stepDt);
    }

    // Task 45: visible cast light per tower (ground pool + downward cone) — one shared pool across
    // all crews, rebuilt every frame from each crew's live tower positions. `floodlightVisibility`
    // is already "night && this crew's job is active, eased" (see updateFloodlight), so reusing it
    // here means the pools/cones fade in/out in lockstep with the emissive head glow and the real
    // SpotLight, no separate night-gating logic to keep in sync.
    for (let crew = 0; crew < this.crews.length; crew++) {
      this.floodlightGroundLightScratch[crew].nightAmount = this.crews[crew].floodlightVisibility;
    }
    this.floodlightGroundLights.update(this.floodlightGroundLightScratch);

    // Shared per-frame updates (Task 25: pools/marks/stakes are shared capacity pools, not
    // per-crew — every crew stamps/spawns into the same ones).
    this.dustPool.update(dt);
    this.steamPool.update(dt);
    this.gravelPool.update(dt);
    this.tireMarks.update(dt);
    this.stakes.update(dt);
  }

  private beaconIntensity(night: boolean): number {
    // beacon pulse: sin-based intensity 0.4..1.6 at 2Hz, doubled at night
    const pulsePhase = Math.sin(2 * Math.PI * BEACON_HZ * this.clock);
    return (1.0 + 0.6 * pulsePhase) * (night ? 2 : 1);
  }

  /** Advances one crew's vehicles, site dressing, and floodlight for one frame. `stepDt` is the
   * timeScale-scaled dt used ONLY for stepVehicle's position/heading catch-up damping (see
   * `update`'s doc comment); every other timer here stays on wall-clock `dt`. */
  private updateCrew(crew: number, dt: number, night: boolean, stepDt: number): void {
    const slot = this.crews[crew];

    // Task 33: break theater — same idle-timeout liveness pattern as every other per-crew signal
    // (see `lastSeenAt`/IDLE_TIMEOUT above). While on break, cyclic vehicle animation (dig cycle,
    // roller oscillation) is suppressed by simply never reporting those vehicles as "working" to
    // their per-kind updaters below — `active` there already eases them to a neutral/idle pose,
    // exactly the same code path as a vehicle between jobs.
    slot.onBreak = this.clock - slot.lastBreakSeenAt <= this.IDLE_TIMEOUT;

    // determine which vehicle kinds are "active" this frame: they received a progress event
    // within IDLE_TIMEOUT seconds (guards against a single stray frame gap causing a pop).
    for (const [kind, state] of slot.states) {
      const lastSeen = slot.lastSeenAt.get(kind) ?? -Infinity;
      const active = this.clock - lastSeen <= this.IDLE_TIMEOUT;
      this.stepVehicle(state, stepDt, active);
    }
    const rollerActive = this.clock - slot.lastRollerSeenAt <= this.IDLE_TIMEOUT && !slot.onBreak;
    this.stepVehicle(slot.roller, stepDt, rollerActive);

    const graderActive = this.clock - slot.lastGraderSeenAt <= this.IDLE_TIMEOUT && !slot.onBreak;
    this.stepVehicle(slot.grader, stepDt, graderActive);

    const beaconIntensity = this.beaconIntensity(night);
    for (const kind of PER_CREW_KINDS) {
      slot.rigs[kind].beaconMat.emissiveIntensity = beaconIntensity;
    }
    slot.grader.rig.beaconMat.emissiveIntensity = beaconIntensity;

    const excavatorState = slot.states.get('excavator');
    const excavatorActive =
      this.clock - (slot.lastSeenAt.get('excavator') ?? -Infinity) <= this.IDLE_TIMEOUT && !slot.onBreak;
    this.updateExcavator(slot, excavatorState, excavatorActive, dt);

    const truckState = slot.states.get('truck');
    const truckActive = this.clock - (slot.lastSeenAt.get('truck') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updateTruck(slot, truckState, truckActive, dt);
    this.updateTruckShuttle(slot, dt, excavatorActive);
    this.updateTruckPavedDock(slot, dt, truckActive);

    const paverState = slot.states.get('paver');
    const paverActive = this.clock - (slot.lastSeenAt.get('paver') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updatePaverMat(slot, paverState, paverActive, dt);

    const linerState = slot.states.get('liner');
    const linerActive = this.clock - (slot.lastSeenAt.get('liner') ?? -Infinity) <= this.IDLE_TIMEOUT;
    this.updateStencil(slot, linerState, linerActive, dt);

    this.updateRoller(slot, dt, rollerActive);
    this.updateGrader(slot, dt, graderActive);

    this.updateTireMarks(slot, dt);
    this.updateFloodlight(slot, dt, night);
    this.updateSiteDressing(slot, dt);
    this.updateStockpileDepletion(slot, dt);
    this.updateWorkers(slot, dt, excavatorActive || truckActive || paverActive || linerActive);
    this.updateCompactor(slot, dt);
    this.updateExhaust(slot, dt);
  }

  /**
   * Site dressing (deliverable 5): finds whichever of THIS CREW's vehicles is currently the
   * "primary" active one (same anchor-picking approach as updateFloodlight) to serve as the
   * flagger/spotter's follow anchor, and fades the job-start stockpile + the (already fixed-
   * position, per Task 27) cone line in/out with whether ANY job is currently active on this crew
   * (cones/stockpile both belong to "this crew has a job in progress", not any one vehicle kind).
   */
  private updateSiteDressing(slot: CrewSlot, dt: number): void {
    let anchor: VehicleState | null = null;
    for (const [kind, state] of slot.states) {
      const lastSeen = slot.lastSeenAt.get(kind) ?? -Infinity;
      if (this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget) {
        anchor = state;
        break;
      }
    }

    slot.dressingActive = anchor !== null;
    if (anchor) {
      slot.dressingPos.copy(anchor.curPos);
      slot.dressingHeading = anchor.curHeading;
    }

    const jobActive = anchor !== null;
    slot.stockpileVisibility = damp(slot.stockpileVisibility, jobActive ? 1 : 0, 1 / FADE_DURATION, dt);
    const scale = easeOutCubic(clamp01(slot.stockpileVisibility));
    slot.stockpile.group.visible = scale > 0.001;
    slot.stockpile.group.scale.setScalar(Math.max(0.001, scale));
    if (!jobActive) slot.stockpileEdgeId = null; // free the anchor once fully faded/no job running

    // Cones (Task 27): positions are already fixed (set once in onProgress); only the shared
    // fade-with-the-crew signal is driven from here. Free the placed-edge gate once fully faded so
    // the next job (even on the same edge, e.g. immediate resume) re-places fresh stations.
    slot.cones.update(dt, jobActive);
    if (!jobActive && slot.stockpileVisibility < 0.001) slot.cones.clear();

    // Floodlight towers (Task 37): same fixed-position, fade-with-the-crew signal as cones. Free
    // the placed-edge gate once fully faded so the next job re-places fresh stations.
    slot.floodlightTowers.update(dt, jobActive);
    if (!jobActive && slot.stockpileVisibility < 0.001) slot.floodlightTowers.clear();
  }

  /**
   * Procedural dig-swing-dump cycle: three explicit phases derived from a single 0..1 progress
   * value looping every DIG_CYCLE_DURATION seconds. `digPhase` is only advanced while the
   * excavator is active AND hasn't relocated more than RELOCATE_THRESHOLD this frame (a same-kind
   * edge handoff or a big damped jump snaps the target far away in one step) — otherwise the rig
   * eases toward a neutral carry pose instead of digging mid-teleport, and the cycle resumes from
   * wherever it left off once the vehicle is back to normal, small-per-frame motion.
   */
  private updateExcavator(slot: CrewSlot, state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = slot.rigs.excavator;
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
          if (state.stage === 'graded' && !state.demolish) this.truckReceiveDump(slot);
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
      slot.dustTimer += dt;
      if (slot.dustTimer >= DUST_INTERVAL) {
        slot.dustTimer = 0;
        this.emitDust(state.curPos.x, state.curPos.y, state.curPos.z);
      }
    } else {
      slot.dustTimer = 0;
    }
  }

  /**
   * Dump truck bed tipping: while depositing gravel at the work front (stage === 'gravel', not
   * demolishing — reversing a demolish crew doesn't deposit anything), tips the bed up to
   * BED_TIP_ANGLE and back down every BED_TIP_INTERVAL seconds, eased over BED_TIP_DURATION each
   * way, with a gravel-colored particle burst at the tailgate while tipped.
   */
  private updateTruck(slot: CrewSlot, state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = slot.rigs.truck;
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
  private truckReceiveDump(slot: CrewSlot): void {
    const truck = slot.states.get('truck');
    if (!truck || truck.shuttlePhase !== 'idle') return;
    truck.dumpCountThisLoad += 1;
    truck.spoilLevel = clamp01(truck.dumpCountThisLoad / SPOIL_DUMPS_TO_FILL);
    if (truck.dumpCountThisLoad >= SPOIL_DUMPS_TO_FILL) {
      truck.shuttlePhase = 'departing';
      truck.shuttleTimer = 0;
      truck.shuttleAwayDuration = SHUTTLE_AWAY_MIN + Math.random() * (SHUTTLE_AWAY_MAX - SHUTTLE_AWAY_MIN);
      // Task 34: head toward the quarry once one exists; falls back to "toward the nearest map
      // edge" unchanged when it doesn't (no road committed yet).
      const target = shuttleAwayTarget(truck.curPos.x, truck.curPos.z, this.quarryPosition);
      truck.shuttleAwayPos.set(target.x, this.hf.heightAt(target.x, target.z), target.z);
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
  private updateTruckShuttle(slot: CrewSlot, dt: number, excavatorActive: boolean): void {
    const truck = slot.states.get('truck');
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

    const rig = slot.rigs.truck;

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
  private updateTruckPavedDock(slot: CrewSlot, dt: number, truckActive: boolean): void {
    const truck = slot.states.get('truck');
    const rig = slot.rigs.truck;
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
  private updatePaverMat(slot: CrewSlot, state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = slot.rigs.paver;
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
  private updateRoller(slot: CrewSlot, dt: number, active: boolean): void {
    const rig = slot.rigs.roller;
    if (!active) {
      slot.steamTimer = 0;
      return;
    }

    const roller = slot.roller;
    const prevOffset = roller.rollerOscOffset;
    roller.rollerOscOffset += roller.rollerOscDir * ROLLER_OSCILLATION_SPEED * dt;
    if (roller.rollerOscOffset > ROLLER_OSCILLATION_RANGE) {
      roller.rollerOscOffset = ROLLER_OSCILLATION_RANGE;
      roller.rollerOscDir = -1;
    } else if (roller.rollerOscOffset < -ROLLER_OSCILLATION_RANGE) {
      roller.rollerOscOffset = -ROLLER_OSCILLATION_RANGE;
      roller.rollerOscDir = 1;
    }

    const offsetDelta = roller.rollerOscOffset - prevOffset;
    const forwardX = Math.cos(roller.curHeading);
    const forwardZ = Math.sin(roller.curHeading);
    rig.group.position.x += forwardX * roller.rollerOscOffset;
    rig.group.position.z += forwardZ * roller.rollerOscOffset;
    // face the direction it's currently oscillating toward so it visibly reads as passes, not drift
    rig.group.rotation.y = -(roller.rollerOscDir > 0 ? roller.curHeading : roller.curHeading + Math.PI);

    for (const w of rig.wheels) {
      w.mesh.rotation.x += Math.abs(offsetDelta) / w.radius;
    }

    slot.steamTimer += dt;
    if (slot.steamTimer >= STEAM_INTERVAL) {
      slot.steamTimer = 0;
      this.emitSteam(rig.group.position.x, rig.group.position.y, rig.group.position.z);
    }
  }

  /**
   * Motor grader (Task 26 deliverable 2): purely cosmetic, trailing the truck's gravel drops
   * GRADER_TRAIL_DISTANCE behind the work front (position/heading synthesized in `onProgress`
   * above). No independent animation beyond the shared `stepVehicle` damping/wheel-spin/slope
   * alignment every other vehicle gets — the blade is modeled permanently lowered (fixed geometry,
   * see `buildGrader`), so all this method needs to do is gate the periodic scrape-audio timer that
   * `ambient.ts` can't derive on its own (it only sees sim-reported vehicle positions, not this
   * render-synthesized trailing one).
   */
  private updateGrader(slot: CrewSlot, dt: number, active: boolean): void {
    if (!active) {
      slot.graderScrapeTimer = 0;
      return;
    }
    slot.graderScrapeTimer += dt;
    if (slot.graderScrapeTimer >= slot.graderScrapeGap) {
      slot.graderScrapeTimer = 0;
      slot.graderScrapeGap = 6 + Math.random() * (10 - 6);
      // Audio cue: a soft scrape one-shot tied to grader passes (deliverable 6). Emitting a DOM
      // CustomEvent rather than threading a new EventBus contract through both files keeps the sim's
      // event surface (core/events.ts) untouched for a purely cosmetic audio tie-in — ambient.ts
      // listens for it directly (see AmbientAudio's constructor). Guarded (Task 36 finding): this
      // is the one spot in the whole class that reaches for a browser global directly, which threw
      // in a plain Node test environment (no `window`) the moment a test started driving
      // `ConstructionRenderer.update()` directly (previously nothing exercised this file outside a
      // real browser) — harmless no-op fallback everywhere `window` isn't defined.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('construction:graderScrape', {
          detail: { x: slot.grader.curPos.x },
        }));
      }
    }
  }

  /**
   * Plate compactor (Task 26 deliverable 2, second prop — the Addendum B line item deferred from
   * the original Task 26 pass): parked on the shoulder beside the freshest dashes, trailing the
   * liner (target synthesized in `onProgress`, same pattern as the grader). Fades with the crew's
   * dressing signal (`slot.dressingActive`, same WORKER_FADE_LAMBDA ease as the workers, set by
   * `updateSiteDressing` earlier this same frame) but additionally gated on painted-stage liveness
   * so it only ever appears near fresh paint, per spec — pure dressing fade would have it standing
   * around from survey onward. While working it plays a faint plate-vibration bob; on break the
   * bob is suppressed (same rule as the roller/grader cycles) so it reads as parked.
   */
  private updateCompactor(slot: CrewSlot, dt: number): void {
    const compacting =
      slot.dressingActive && this.clock - slot.lastCompactorSeenAt <= this.IDLE_TIMEOUT;

    // Snap into place whenever it starts fading in from fully hidden — the first placement of a
    // session and every re-appearance on a later job both read as "already parked" rather than
    // sliding in from wherever the previous job left it (same intent as the spotter's
    // first-placement snap).
    if (compacting && slot.compactorVisibility < 0.001) {
      slot.compactorPos.set(slot.compactorTarget.x, 0, slot.compactorTarget.z);
      slot.compactorHeading = slot.compactorTargetHeading;
    }

    slot.compactorVisibility = damp(slot.compactorVisibility, compacting ? 1 : 0, WORKER_FADE_LAMBDA, dt);
    const scale = easeOutCubic(clamp01(slot.compactorVisibility));
    slot.compactor.group.visible = scale > 0.001;
    slot.compactor.group.scale.setScalar(Math.max(0.001, scale));
    if (!compacting) return; // hold the last pose through the fade-out, same as the workers

    slot.compactorPos.x = damp(slot.compactorPos.x, slot.compactorTarget.x, COMPACTOR_LAMBDA, dt);
    slot.compactorPos.z = damp(slot.compactorPos.z, slot.compactorTarget.z, COMPACTOR_LAMBDA, dt);
    // over a bridge the road sample's own height IS the deck; everywhere else follow the terrain
    // under the damped position (the shoulder sits off the road surface, at terrain height).
    const baseY = slot.compactorOnBridge
      ? slot.compactorTarget.y
      : this.hf.heightAt(slot.compactorPos.x, slot.compactorPos.z);

    let vibeY = 0;
    if (!slot.onBreak) {
      slot.compactorVibePhase += dt;
      vibeY =
        Math.abs(Math.sin(2 * Math.PI * COMPACTOR_VIBE_HZ * slot.compactorVibePhase)) *
        COMPACTOR_VIBE_AMOUNT * scale;
    }
    slot.compactor.group.position.set(slot.compactorPos.x, baseY + vibeY, slot.compactorPos.z);

    let delta = slot.compactorTargetHeading - slot.compactorHeading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    slot.compactorHeading += delta * (1 - Math.exp(-ROT_LAMBDA * dt));
    slot.compactor.group.rotation.y = -slot.compactorHeading;
  }

  /**
   * Worker figures (Task 26 deliverable 1): a flagger near the cones (slow arm wave), a spotter
   * that paces the active vehicle from SPOTTER_STANDOFF away (damped walk-steps, small bob while
   * actually moving), and a stockpile worker with an occasional shovel-lean cycle. All three fade
   * in/out with the same job-active signal as cones/stockpile (`slot.dressingActive`, set by
   * `updateSiteDressing` earlier this same frame) rather than tracking their own liveness, so
   * workers never linger after every vehicle on the crew has gone idle. `anyVehicleActive` is passed
   * in as a slightly richer signal for the spotter's target (needs an actual vehicle to face).
   */
  private updateWorkers(slot: CrewSlot, dt: number, anyVehicleActive: boolean): void {
    const active = slot.dressingActive;
    slot.workerVisibility = damp(slot.workerVisibility, active ? 1 : 0, WORKER_FADE_LAMBDA, dt);
    const scale = easeOutCubic(clamp01(slot.workerVisibility));
    const visible = scale > 0.001;

    // Task 33: break huddle spot — a fixed point just beside the stockpile (reusing the same prop
    // the stockpile worker already idles next to), offset so the flagger/spotter don't overlap
    // them or each other. Computed fresh each frame from the stockpile's own (already-placed)
    // position rather than cached, since the stockpile itself doesn't move during a job.
    const huddleBase = slot.stockpile.group.position;
    const flaggerHuddleX = huddleBase.x + 1.6;
    const flaggerHuddleZ = huddleBase.z - 1.2;
    const spotterHuddleX = huddleBase.x + 2.4;
    const spotterHuddleZ = huddleBase.z + 0.4;

    // --- Flagger: stationed just behind the cone bracket, facing the road, slow wave cycle —
    // EXCEPT on break, when it instead walks to (and idles at) the huddle spot beside the
    // stockpile, arm relaxed (light touch: same damped position, no wave animation). ---
    slot.flagger.group.visible = visible;
    slot.flagger.group.scale.setScalar(Math.max(0.001, scale));
    if (active && slot.onBreak) {
      const fy = this.hf.heightAt(flaggerHuddleX, flaggerHuddleZ);
      const cur = slot.flagger.group.position;
      const dampedX = damp(cur.x, flaggerHuddleX, SPOTTER_LAMBDA, dt);
      const dampedZ = damp(cur.z, flaggerHuddleZ, SPOTTER_LAMBDA, dt);
      slot.flagger.group.position.set(dampedX, fy, dampedZ);
      slot.flagger.group.rotation.y = Math.atan2(huddleBase.x - dampedX, huddleBase.z - dampedZ);
      slot.flagger.arm.rotation.z = damp(slot.flagger.arm.rotation.z, -0.2, 6, dt);
    } else if (active) {
      const perpX = -Math.sin(slot.dressingHeading);
      const perpZ = Math.cos(slot.dressingHeading);
      const fx = slot.dressingPos.x + perpX * (ROAD_WIDTH_HALF + 3) - Math.cos(slot.dressingHeading) * 4;
      const fz = slot.dressingPos.z + perpZ * (ROAD_WIDTH_HALF + 3) - Math.sin(slot.dressingHeading) * 4;
      const fy = this.hf.heightAt(fx, fz);
      slot.flagger.group.position.set(fx, fy, fz);
      slot.flagger.group.rotation.y = -slot.dressingHeading + Math.PI / 2;
      slot.flaggerPhase += dt;
      const waveAngle = Math.sin(2 * Math.PI * FLAGGER_WAVE_HZ * slot.flaggerPhase) * FLAGGER_WAVE_AMOUNT;
      slot.flagger.arm.rotation.z = -0.3 + waveAngle;
    }

    // --- Spotter: stands ~SPOTTER_STANDOFF from the active vehicle, facing it, damped walk-steps
    // as the work front advances (slower lambda than the vehicle itself so it visibly "keeps up"
    // rather than teleporting alongside it) — EXCEPT on break, when it walks to the huddle spot
    // beside the stockpile instead (same damped-walk machinery, different target/no vehicle-facing). ---
    slot.spotter.group.visible = visible;
    slot.spotter.group.scale.setScalar(Math.max(0.001, scale));
    if (active && slot.onBreak) {
      const prevX = slot.spotterPos.x;
      const prevZ = slot.spotterPos.z;
      slot.spotterPos.x = damp(prevX, spotterHuddleX, SPOTTER_LAMBDA, dt);
      slot.spotterPos.z = damp(prevZ, spotterHuddleZ, SPOTTER_LAMBDA, dt);
      const spotterY = this.hf.heightAt(slot.spotterPos.x, slot.spotterPos.z);

      const moveDist = Math.hypot(slot.spotterPos.x - prevX, slot.spotterPos.z - prevZ);
      const moveSpeed = dt > 0 ? moveDist / dt : 0;
      let bobY = 0;
      if (moveSpeed > SPOTTER_MOVE_EPS) {
        slot.spotterStepPhase += dt * SPOTTER_STEP_HZ;
        bobY = Math.abs(Math.sin(2 * Math.PI * slot.spotterStepPhase)) * SPOTTER_BOB_AMOUNT;
      }
      // Face the flagger/stockpile huddle center rather than any vehicle while on break.
      const toHuddle = Math.atan2(huddleBase.z - slot.spotterPos.z, huddleBase.x - slot.spotterPos.x);
      slot.spotterHeading = slot.spotterHeading + Math.atan2(Math.sin(toHuddle - slot.spotterHeading), Math.cos(toHuddle - slot.spotterHeading)) * (1 - Math.exp(-ROT_LAMBDA * dt));

      slot.spotter.group.position.set(slot.spotterPos.x, spotterY + bobY, slot.spotterPos.z);
      slot.spotter.group.rotation.y = -slot.spotterHeading;
      slot.spotter.arm.rotation.z = damp(slot.spotter.arm.rotation.z, 0, 6, dt);
    } else if (active && anyVehicleActive) {
      const anchor = slot.dressingPos;
      const perpX = -Math.sin(slot.dressingHeading);
      const perpZ = Math.cos(slot.dressingHeading);
      const targetX = anchor.x + perpX * SPOTTER_STANDOFF - Math.cos(slot.dressingHeading) * 2;
      const targetZ = anchor.z + perpZ * SPOTTER_STANDOFF - Math.sin(slot.dressingHeading) * 2;

      // First-ever placement: snap directly rather than damping in from the (0,0) default — a
      // freshly-idle crew's spotter has never been positioned, so damping would read as "walking in
      // from the map origin" on the very first frame it appears.
      if (!slot.spotter.group.visible && slot.spotterPos.x === 0 && slot.spotterPos.z === 0) {
        slot.spotterPos.set(targetX, 0, targetZ);
      }
      const prevX = slot.spotterPos.x;
      const prevZ = slot.spotterPos.z;
      slot.spotterPos.x = damp(prevX, targetX, SPOTTER_LAMBDA, dt);
      slot.spotterPos.z = damp(prevZ, targetZ, SPOTTER_LAMBDA, dt);
      const spotterY = this.hf.heightAt(slot.spotterPos.x, slot.spotterPos.z);

      const moveDist = Math.hypot(slot.spotterPos.x - prevX, slot.spotterPos.z - prevZ);
      const moveSpeed = dt > 0 ? moveDist / dt : 0;
      let bobY = 0;
      if (moveSpeed > SPOTTER_MOVE_EPS) {
        slot.spotterStepPhase += dt * SPOTTER_STEP_HZ;
        bobY = Math.abs(Math.sin(2 * Math.PI * slot.spotterStepPhase)) * SPOTTER_BOB_AMOUNT;
      }

      // Face the vehicle it's spotting for.
      const toVehicle = Math.atan2(anchor.z - slot.spotterPos.z, anchor.x - slot.spotterPos.x);
      slot.spotterHeading = slot.spotterHeading + Math.atan2(Math.sin(toVehicle - slot.spotterHeading), Math.cos(toVehicle - slot.spotterHeading)) * (1 - Math.exp(-ROT_LAMBDA * dt));

      slot.spotter.group.position.set(slot.spotterPos.x, spotterY + bobY, slot.spotterPos.z);
      slot.spotter.group.rotation.y = -slot.spotterHeading;
      // arm relaxed at the side, only the flagger/shovel workers gesture
      slot.spotter.arm.rotation.z = damp(slot.spotter.arm.rotation.z, 0, 6, dt);
    }

    // --- Stockpile worker: idles beside the stockpile, occasional shovel-lean cycle ---
    slot.stockpileWorker.group.visible = visible;
    slot.stockpileWorker.group.scale.setScalar(Math.max(0.001, scale));
    if (active) {
      const sp = slot.stockpile.group.position;
      const wx = sp.x - 1.4;
      const wz = sp.z + 1.6;
      const wy = this.hf.heightAt(wx, wz);
      slot.stockpileWorker.group.position.set(wx, wy, wz);
      slot.stockpileWorker.group.rotation.y = slot.dressingHeading;

      // Task 33: on break the stockpile worker just stands down (no new shovel-lean cycles roll)
      // rather than mid-swing — reads as a genuine pause rather than a frozen shovel.
      if (slot.shovelActive && !slot.onBreak) {
        slot.shovelPhase += dt;
        const u = clamp01(slot.shovelPhase / SHOVEL_CYCLE_DURATION);
        // lean forward-and-back: 0 -> lean(1) -> back(0), a single easeOutCubic-in/out hump
        const lean = Math.sin(u * Math.PI);
        slot.stockpileWorker.arm.rotation.z = -0.2 - lean * 0.9;
        slot.stockpileWorker.group.rotation.x = lean * 0.15;
        if (u >= 1) {
          slot.shovelActive = false;
          slot.shovelPhase = 0;
          slot.shovelIdleGap = SHOVEL_IDLE_GAP_MIN + Math.random() * (SHOVEL_IDLE_GAP_MAX - SHOVEL_IDLE_GAP_MIN);
        }
      } else {
        slot.stockpileWorker.arm.rotation.z = damp(slot.stockpileWorker.arm.rotation.z, -0.2, 6, dt);
        slot.stockpileWorker.group.rotation.x = damp(slot.stockpileWorker.group.rotation.x, 0, 6, dt);
        if (slot.onBreak) {
          // Frozen at "idle stance" for the whole break — don't roll for a new cycle.
          slot.shovelPhase = 0;
        } else {
          slot.shovelPhase += dt;
          if (slot.shovelPhase >= slot.shovelIdleGap) {
            slot.shovelPhase = 0;
            if (Math.random() < SHOVEL_CYCLE_CHANCE) {
              slot.shovelActive = true;
            } else {
              slot.shovelIdleGap = SHOVEL_IDLE_GAP_MIN + Math.random() * (SHOVEL_IDLE_GAP_MAX - SHOVEL_IDLE_GAP_MIN);
            }
          }
        }
      }
    }
  }

  /**
   * Stockpile depletion (Task 26 deliverable 4): the gravel mound scales down across the job's
   * stage progression — full (1.0) at survey/graded, tapering to STOCKPILE_MIN_SCALE by painting.
   * Each job gets its own stockpile at its own start point (existing per-crew behavior, see
   * `onProgress`'s stockpileEdgeId capture), so this simply reads whichever stage this crew's
   * active anchor last reported and eases the mound's own scale toward that stage's target.
   */
  private updateStockpileDepletion(slot: CrewSlot, dt: number): void {
    let stage: string | null = null;
    for (const [kind, state] of slot.states) {
      const lastSeen = slot.lastSeenAt.get(kind) ?? -Infinity;
      if (this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget) {
        stage = state.stage;
        break;
      }
    }
    const stageIdx = stage ? Math.max(0, STAGES.indexOf(stage as Stage)) : 0;
    const stageFrac = STAGES.length > 1 ? stageIdx / (STAGES.length - 1) : 0;
    const targetScale = THREE.MathUtils.lerp(1, STOCKPILE_MIN_SCALE, stageFrac);
    slot.stockpileScale = damp(slot.stockpileScale, targetScale, STOCKPILE_SCALE_LAMBDA, dt);
    slot.stockpile.moundGroup.scale.setScalar(Math.max(0.05, slot.stockpileScale));
  }

  /**
   * Paint stencil + wet sheen (Task 26 deliverable 5): the stencil frame prop simply fades in/out
   * with the liner's own liveness (it's part of the liner rig, see `buildLiner`'s `stencilMesh`) —
   * no additional per-frame positioning needed since it's parented to the liner's group. Wet-sheen
   * on the fresh dashes themselves is handled in `roadRenderer.ts` (mirrors the fresh-asphalt
   * roughness lerp there); this method only owns the stencil prop's opacity fade.
   */
  private updateStencil(slot: CrewSlot, state: VehicleState | undefined, active: boolean, dt: number): void {
    const rig = slot.rigs.liner;
    const painting = !!state && active && state.stage === 'painted';
    const targetOpacity = painting ? 0.9 : 0;
    rig.stencilMat!.opacity = damp(rig.stencilMat!.opacity, targetOpacity, 1 / MAT_FADE_TIME, dt);
    rig.stencilMesh!.visible = rig.stencilMat!.opacity > 0.01;
  }

  /**
   * Exhaust puffs (Task 26 deliverable 3): small dark particles from each active vehicle's exhaust
   * stack, reusing the ParticlePool mechanism at a subtle rate (~1 puff/EXHAUST_INTERVAL per active
   * vehicle). Spawned a little above and behind each vehicle's own position/heading so it reads as
   * coming from a stack rather than the ground. The grader and roller (purely cosmetic trailing
   * rigs) get puffs too — they're still "working" vehicles for this purpose.
   */
  private updateExhaust(slot: CrewSlot, dt: number): void {
    for (const [kind, state] of slot.states) {
      const lastSeen = slot.lastSeenAt.get(kind) ?? -Infinity;
      const active = this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget && state.scale > 0.5;
      this.advanceExhaustTimer(slot, kind, state, active, dt);
    }
    const rollerActive = this.clock - slot.lastRollerSeenAt <= this.IDLE_TIMEOUT && slot.roller.scale > 0.5;
    this.advanceExhaustTimer(slot, 'roller', slot.roller, rollerActive, dt);
    const graderActive = this.clock - slot.lastGraderSeenAt <= this.IDLE_TIMEOUT && slot.grader.scale > 0.5;
    this.advanceExhaustTimer(slot, 'grader', slot.grader, graderActive, dt);
  }

  /** Shared per-vehicle exhaust-timer/spawn logic used by `updateExhaust`. `key` is a plain string
   * (not `VehicleKind`) so the grader — a purely render-synthesized rig with no corresponding
   * VehicleKind in the sim's event contract — can use its own dedicated map slot ('grader') without
   * risking a collision with a real per-crew vehicle's timer. */
  private advanceExhaustTimer(slot: CrewSlot, key: string, state: VehicleState, active: boolean, dt: number): void {
    if (!active) {
      slot.exhaustTimer.set(key, 0);
      return;
    }
    const t = (slot.exhaustTimer.get(key) ?? 0) + dt;
    if (t >= EXHAUST_INTERVAL) {
      slot.exhaustTimer.set(key, 0);
      const upX = -Math.sin(state.curHeading) * 0.3;
      const upZ = Math.cos(state.curHeading) * 0.3;
      const backX = -Math.cos(state.curHeading) * 0.6;
      const backZ = -Math.sin(state.curHeading) * 0.6;
      this.exhaustPool.spawn(
        state.curPos.x + backX + upX * 0.2,
        state.curPos.y + 1.1,
        state.curPos.z + backZ + upZ * 0.2,
        (Math.random() - 0.5) * 0.15,
        0.5 + Math.random() * 0.3,
        (Math.random() - 0.5) * 0.15,
      );
    } else {
      slot.exhaustTimer.set(key, t);
    }
  }

  /**
   * Bridge crane theater (Task 22 deliverables 3/4): for every edge currently mid-crossing of a
   * bridge run during 'gravel'-stage work, stations the crane rig at the run's near end, slews its
   * cab to track whichever span is currently descending, and advances that span's descend
   * (easeOutCubic, SEGMENT_DESCEND_DURATION) then settle-bounce (easeOutBack,
   * SEGMENT_SETTLE_BOUNCE_DURATION) animation. On completion, hands off to `settleBridgeSpan` (marks
   * the span settled in `roadRenderer`, which un-masks that stretch of the real deck ribbon/rails).
   * Demolition crossings never show the crane at all (deliverable 6: reverse is a simple recede,
   * already fully handled by `onGravelBridgeProgress`'s mask update) — this method only animates
   * the crane/segment for non-demolish crossings, though it still runs the shared idle-timeout
   * cleanup for both directions.
   */
  private updateBridgeCrossings(dt: number): void {
    let anyForwardActive = false;

    for (const [edgeId, crossing] of this.bridgeCrossings) {
      const idle = this.clock - crossing.lastProgressAt > this.IDLE_TIMEOUT;
      const edgeStillExists = this.graph.edges.has(edgeId);
      // A short final bridge remainder can leave the run before its 1.85s descend+bounce has
      // finished. Keep that last span alive past the generic 0.2s vehicle-liveness timeout; once
      // settleBridgeSpan completes, the next frame enters the normal cleanup below and clears the
      // fully-settled mask. Removed edges still clean up immediately.
      if (idle && (crossing.activeSpanIdx === null || !edgeStillExists)) {
        // Job moved off this bridge run (finished crossing it, or the whole job went idle/ended).
        // If every span settled, this was a clean completion — nothing left to mask, drop the
        // crossing entirely. Otherwise (job ended mid-crossing, e.g. edge externally removed)
        // leave roadRenderer's mask exactly where it last was rather than guessing; either way the
        // crane itself stops being fed a target and fades out via the normal liveness timeout.
        this.bridgeCrossings.delete(edgeId);
        if (!crossing.demolish && crossing.settledUpTo >= crossing.runToDist - 0.01) {
          this.roadRenderer.setBridgeMask(edgeId, null);
        }
        continue;
      }
      if (crossing.demolish) continue; // reverse teardown: no crane, nothing further to animate here

      anyForwardActive = true;
      const edge = this.graph.edges.get(edgeId);
      if (!edge) continue;

      // Station the crane at the run's near end, facing along the run. The crane rig is shared
      // globally (see class doc) — if more than one edge is mid-crossing at once, whichever
      // crossing this loop iterates last "wins" the crane visual for this frame; every crossing's
      // own mask/settle logic is unaffected either way (that's driven by `roadRenderer`, not the
      // crane rig itself), so a second simultaneous crossing's spans still settle correctly, just
      // without their own crane visual — the documented Task 25 simplification.
      const { pos: stationPos, heading: stationHeading } = sampleAt(edge.samples, crossing.runFromDist);
      this.applyProgressTarget(this.craneState, edgeId, new THREE.Vector3(stationPos.x, stationPos.y, stationPos.z), stationHeading);
      this.craneState.stage = 'gravel';
      this.craneState.demolish = false;
      this.craneState.onBridge = false; // the crane itself sits on the approach, not the deck

      // Advance the current span's descend -> settle-bounce animation.
      if (crossing.activeSpanIdx !== null) {
        crossing.elapsed += dt;
        if (crossing.phase === 'descending' && crossing.elapsed >= SEGMENT_DESCEND_DURATION) {
          crossing.phase = 'bouncing';
          crossing.elapsed = 0;
        } else if (crossing.phase === 'bouncing' && crossing.elapsed >= SEGMENT_SETTLE_BOUNCE_DURATION) {
          this.settleBridgeSpan(crossing);
        }
      }

      this.applyCraneArticulation(this.craneRig, edge, crossing, dt);
    }

    if (!anyForwardActive) {
      // No forward (build) crossing active anywhere: make sure the crane segment mesh is hidden
      // rather than left showing a stale descended segment from the last crossing it animated.
      this.craneSegmentMat.opacity = damp(this.craneSegmentMat.opacity, 0, 1 / FADE_DURATION, dt);
      if (this.craneSegmentMat.opacity <= 0.01) this.craneSegment.visible = false;
      if (this.craneRig.craneCable) this.craneRig.craneCable.scale.y = damp(this.craneRig.craneCable.scale.y, 0.001, 8, dt);
    }
  }

  /**
   * Positions/scales the crane's cab slew + cable (both cosmetic, near the crane's own fixed
   * station) and the standalone world-space deck-segment mesh (see `buildCraneSegment`) for the
   * span `crossing` is currently animating.
   *
   * The boom has a fixed physical reach, but bridge spans can sit many multiples of that reach
   * away from the crane's stationary base — so rather than pretend the hook itself travels all the
   * way out to the span (which would require either an implausibly long boom or literally
   * relocating the crane every span), the cab still slews to visually "aim" at the current span
   * and the cable still pays in/out near the crane as a "the crane is doing this" cue, but the
   * actual descending segment is a separate mesh placed directly at the span's real world position
   * — this is the part players actually watch land, so it must never be anywhere else.
   */
  private applyCraneArticulation(rig: VehicleRig, edge: { samples: Parameters<typeof sampleAt>[0] }, crossing: BridgeCrossing, dt: number): void {
    if (!rig.craneCab || !rig.craneCable || !rig.craneHook) return;
    if (crossing.activeSpanIdx === null) {
      this.craneSegmentMat.opacity = damp(this.craneSegmentMat.opacity, 0, 1 / FADE_DURATION, dt);
      if (this.craneSegmentMat.opacity <= 0.01) this.craneSegment.visible = false;
      return;
    }

    const spanMid = (crossing.segmentFrom + crossing.segmentTo) / 2;
    const { pos: spanPos, heading: spanHeading } = sampleAt(edge.samples, spanMid);
    const stationPos = rig.group.position;
    // Slew (cab yaw) tracks the bearing from the crane's station to the span's midpoint, in the
    // rig's own local frame (subtract the rig's own world yaw, which `stepVehicle` already applied
    // to `rig.group.rotation.y`).
    const worldBearing = Math.atan2(spanPos.z - stationPos.z, spanPos.x - stationPos.x);
    const targetYaw = worldBearing + rig.group.rotation.y; // rig.group.rotation.y = -heading
    let deltaYaw = targetYaw - crossing.cabYaw;
    deltaYaw = Math.atan2(Math.sin(deltaYaw), Math.cos(deltaYaw));
    crossing.cabYaw += deltaYaw * (1 - Math.exp(-CRANE_SLEW_LAMBDA * dt));
    rig.craneCab.rotation.y = crossing.cabYaw;

    // Descend -> settle-bounce: `u` is the segment's height above the deck (SEGMENT_DROP_HEIGHT ->
    // 0), eased down during 'descending' and holding at (a tiny bounce around) 0 during 'bouncing'.
    let dropHeight: number;
    if (crossing.phase === 'descending') {
      const u = clamp01(crossing.elapsed / SEGMENT_DESCEND_DURATION);
      dropHeight = SEGMENT_DROP_HEIGHT * (1 - easeOutCubic(u));
    } else {
      const u = clamp01(crossing.elapsed / SEGMENT_SETTLE_BOUNCE_DURATION);
      // easeOutBack overshoots past 1 then settles back to 1; invert so the segment dips slightly
      // below its resting height and springs back, reading as a small settle bounce on landing.
      const bounce = 1 - easeOutBack(u);
      dropHeight = Math.max(0, -bounce * 0.3);
    }

    // Cable/hook: a simple cosmetic pay-out near the crane's own boom tip, tracking the same
    // descend progress (0 = fully hoisted, 1 = fully paid out) without trying to reach the span.
    const descendU = crossing.phase === 'descending'
      ? clamp01(crossing.elapsed / SEGMENT_DESCEND_DURATION)
      : 1;
    const cableLength = 1 + descendU * 3;
    rig.craneCable.scale.y = cableLength;
    rig.craneHook.position.y = -cableLength;

    // The actual deck segment: placed in world space at the span's real position/heading, easing
    // down from SEGMENT_DROP_HEIGHT above the deck to the deck surface itself.
    this.craneSegment.visible = true;
    this.craneSegment.position.set(spanPos.x, spanPos.y + dropHeight, spanPos.z);
    this.craneSegment.rotation.y = -spanHeading;
    this.craneSegmentMat.opacity = damp(this.craneSegmentMat.opacity, 0.95, 1 / 0.3, dt);
    const segLen = crossing.segmentTo - crossing.segmentFrom;
    // rotation.y = -spanHeading maps local +X onto the road direction: X is the slab's LENGTH
    // along the run, Z its width across the deck (was swapped — a 16u-wide plank over a 6u road).
    this.craneSegment.scale.set(Math.max(1, segLen), 1, ROAD_WIDTH * 0.9);
  }

  /**
   * Tire/track marks: fading instanced decals stamped under moving vehicles while the terrain is
   * still dirt (graded/gravel stages) — paved/painted stages have a hard surface, no marks. Each
   * active vehicle stamps at most once every TIRE_MARK_INTERVAL seconds so the bounded pool covers a
   * good stretch of road without instantly cycling through on a single pass.
   */
  private updateTireMarks(slot: CrewSlot, dt: number): void {
    const updateState = (state: VehicleState, kind: VehicleKind | 'grader') => {
      if (!state.hasTarget) return;
      const marking = (state.stage === 'graded' || state.stage === 'gravel') && state.curSpeed > 0.2;
      if (!marking) {
        state.tireMarkTimer = 0;
        return;
      }
      state.tireMarkTimer += dt;
      if (state.tireMarkTimer >= TIRE_MARK_INTERVAL) {
        state.tireMarkTimer = 0;
        const cos = Math.cos(state.curHeading), sin = Math.sin(state.curHeading);
        for (const contact of vehicleGroundContacts(kind)) {
          const x = state.curPos.x + cos * contact.longitudinal - sin * contact.lateral;
          const z = state.curPos.z + sin * contact.longitudinal + cos * contact.lateral;
          this.tireMarks.stamp(x, state.curPos.y, z, state.curHeading, contact.width, contact.length);
        }
      }
    };
    for (const [kind, state] of slot.states) updateState(state, kind);
    updateState(slot.roller, 'roller');
    updateState(slot.grader, 'grader');
  }

  /**
   * Floodlight towers (Task 37): the towers themselves are fixed props (placed once per edge,
   * faded by `updateSiteDressing` exactly like cones — see there). This method only drives the
   * ONE budgeted SpotLight per crew: it finds whichever tower is nearest the crew's current work
   * front and parents the light's *aim* there, cross-fading over `FLOODLIGHT_LIGHT_EASE` seconds
   * whenever the nearest tower changes (so the light eases from the old tower to the new one
   * instead of popping or visibly sliding along the road), plus the shared night-gated visibility
   * that also drives every placed tower head's emissive glow — appears when it's night AND a job
   * is actively being reported (any vehicle kind active this frame), eased in/out exactly as
   * before so a job already running when night falls eases the light in, and a job that finishes
   * mid-night eases it back out.
   */
  private updateFloodlight(slot: CrewSlot, dt: number, night: boolean): void {
    let anchor: VehicleState | null = null;
    for (const [kind, state] of slot.states) {
      const lastSeen = slot.lastSeenAt.get(kind) ?? -Infinity;
      if (this.clock - lastSeen <= this.IDLE_TIMEOUT && state.hasTarget) {
        anchor = state;
        break;
      }
    }

    const wantVisible = night && anchor !== null;
    const target = wantVisible ? 1 : 0;
    slot.floodlightVisibility = damp(slot.floodlightVisibility, target, 1 / FLOODLIGHT_EASE, dt);

    const towers = slot.floodlightTowers;
    const visible = slot.floodlightVisibility > 0.01 && anchor !== null && towers.count > 0;
    slot.floodlightLight.visible = visible;

    if (visible && anchor) {
      const nearest = towers.nearestTowerIndex(anchor.curPos.x, anchor.curPos.z);
      if (nearest !== slot.floodlightAnchorTower) {
        // Anchor tower changed (work front advanced past the midpoint to the next tower, or a
        // fresh placement reset it to -1): capture the light's last world position as the
        // cross-fade's starting point and begin easing toward the new tower from there.
        if (slot.floodlightAnchorTower >= 0) {
          slot.floodlightPrevPos.copy(slot.floodlightLight.position);
        } else if (nearest >= 0) {
          // First pick after placement/reset — start already at the chosen tower, no fade-slide.
          const p = towers.towerPos(nearest);
          slot.floodlightPrevPos.set(p.x, p.y, p.z);
        }
        slot.floodlightAnchorTower = nearest;
        slot.floodlightLightMix = 0;
      }

      if (nearest >= 0) {
        slot.floodlightLightMix = Math.min(1, slot.floodlightLightMix + dt / FLOODLIGHT_LIGHT_EASE);
        const mixT = easeOutCubic(slot.floodlightLightMix);
        const p = towers.towerPos(nearest);
        const lightY = p.y + 6.1; // matches the tower head's mounted height
        slot.floodlightLight.position.set(
          THREE.MathUtils.lerp(slot.floodlightPrevPos.x, p.x, mixT),
          THREE.MathUtils.lerp(slot.floodlightPrevPos.y, lightY, mixT),
          THREE.MathUtils.lerp(slot.floodlightPrevPos.z, p.z, mixT),
        );
        // Aim down-road at the work front (the anchor vehicle's current position).
        slot.floodlightLightTarget.position.copy(anchor.curPos);
      }
    }

    // Intensity cross-fades with the anchor-tower mix too, so a light easing between two towers
    // dips slightly rather than holding full brightness while visibly translating (reads as "the
    // beam is swinging to the next tower", not "the light teleported").
    const mixEase = slot.floodlightAnchorTower >= 0 ? easeOutCubic(slot.floodlightLightMix) : 1;
    slot.floodlightLight.intensity = slot.floodlightVisibility * 6 * (0.4 + 0.6 * mixEase);
    towers.setHeadEmissive(slot.floodlightVisibility * FLOODLIGHT_HEAD_EMISSIVE);
  }

  private disposeRig(rig: VehicleRig): void {
    this.scene.remove(rig.group);
    rig.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    for (const m of rig.materials) m.dispose();
    rig.beaconMat.dispose();
  }

  dispose(): void {
    for (const slot of this.crews) {
      for (const kind of PER_CREW_KINDS) {
        this.disposeRig(slot.rigs[kind]);
      }

      this.scene.remove(slot.cones.mesh);
      slot.cones.dispose();

      this.scene.remove(slot.stockpile.group);
      slot.stockpile.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      for (const m of slot.stockpile.materials) m.dispose();

      this.scene.remove(slot.floodlightTowers.poleMesh);
      this.scene.remove(slot.floodlightTowers.headMesh);
      slot.floodlightTowers.dispose();
      this.scene.remove(slot.floodlightLight);
      this.scene.remove(slot.floodlightLightTarget);

      for (const w of [slot.flagger, slot.spotter, slot.stockpileWorker]) {
        this.scene.remove(w.group);
        w.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
        for (const m of w.materials) m.dispose();
      }

      this.disposeRig(slot.grader.rig);

      this.scene.remove(slot.compactor.group);
      slot.compactor.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      for (const m of slot.compactor.materials) m.dispose();
    }

    this.disposeRig(this.craneRig);

    this.scene.remove(this.dustPool.points);
    this.scene.remove(this.steamPool.points);
    this.scene.remove(this.gravelPool.points);
    this.scene.remove(this.exhaustPool.points);
    this.scene.remove(this.tireMarks.mesh);
    this.scene.remove(this.stakes.mesh);
    this.dustPool.dispose();
    this.steamPool.dispose();
    this.gravelPool.dispose();
    this.exhaustPool.dispose();
    this.tireMarks.dispose();
    this.stakes.dispose();

    this.scene.remove(this.craneSegment);
    this.craneSegment.geometry.dispose();
    this.craneSegmentMat.dispose();

    this.scene.remove(this.floodlightGroundLights.poolMesh);
    this.scene.remove(this.floodlightGroundLights.coneMesh);
    this.floodlightGroundLights.dispose();
  }
}

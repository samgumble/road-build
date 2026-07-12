# Junction Controls and Living Weather Design

**Date:** 2026-07-12  
**Status:** Approved design; implementation planning pending  
**Project:** Groundwork

## Goal

Keep every road connection visually coherent as the network changes, introduce slowly evolving
stop-sign and traffic-light control that cars genuinely obey, and replace binary rain scheduling
with a richer presentation-only weather system.

The three changes share one player-facing promise: the island should visibly adapt to the network
without generating unstable geometry, arbitrary traffic behavior, or distracting environmental
changes.

## Scope and constraints

- Connection cleanup is event-driven. It runs only after a topology transaction changes a road
  connection, or after a junction's traffic-control mode upgrades.
- Degree-2 joins are clean road seams, not controlled intersections. This includes closed-loop
  split nodes and two roads tied end-to-end.
- Degree-3+ nodes are conflict junctions. Their topology is cleaned when the connection is made,
  while stop control becomes active only when at least three incident approaches are painted and
  therefore routable by traffic.
- Signals appear only after sustained demand and development pressure. Promotion is slow,
  persisted, and sticky.
- Weather is presentation-only. It must not change traffic, construction, growth, routing, or
  vehicle physics.
- Existing saves migrate. Existing road topology, settlement records, decay state, quarry state,
  and time of day remain intact.
- Simulation decisions remain deterministic for a fixed seed and input sequence.
- High-quality rendering remains below the existing 250 draw-call budget; low quality does not
  allocate additional post-processing passes.
- UI additions remain concise and mobile-safe.

## Alternatives considered

### Renderer-only controls

Rebuild junction visuals and place decorative signs/lights while retaining the current traffic
lock behavior. This is small but misleading: cars would not obey the displayed controls, control
evolution would have no authoritative owner, and save behavior would be undefined.

### TrafficSim-owned controls

Put control classification, maturity, signal phases, stop queues, and render-facing state directly
inside `TrafficSim`. This would work, but further enlarge a file that already owns spawning,
routing, car following, junction locking, settlement weighting, and deadlock recovery.

### Shared junction policy plus independent weather state machine — selected

A focused junction subsystem owns topology classification and slowly evolving policy. Traffic and
rendering consume its public decisions through narrow APIs/events. Weather remains an independent
presentation system. This keeps topology, policy, motion, rendering, and atmosphere independently
testable.

## Connection lifecycle and geometry ownership

### Transaction-level topology signal

`RoadGraph` will emit one additive `roads:connectionsChanged` event after a complete topology
transaction. Its payload contains the surviving affected node IDs. A transaction includes:

- committing a new road;
- connecting to an existing endpoint;
- splitting an existing edge to insert a connection;
- closing a loop;
- removing an edge; and
- replacing an edge during a split.

Existing per-edge events remain for queueing, lane rebuilds, and resource disposal. Connection
cleanup listens only to `roads:connectionsChanged`, preventing repeated work while a split emits
its remove/add sequence.

### Dirty-node rebuild

For each affected node, `RoadRenderer` rebuilds:

1. the shared seam/junction surface owned by that node; and
2. every surviving incident edge visual whose endpoint treatment depends on the node degree.

It does not rebuild unrelated edges. Traffic passage, settlement spawning, weather updates, and
routine frame updates never trigger topology cleanup.

Construction-stage events may update a cached seam/junction material, control visibility, or
surface visibility as a road progresses, but they do not recompute topology. Reaching the third
painted approach activates the already-planned stop control without a second geometry cleanup.

### Degree-based geometry policy

- **Degree 1:** ordinary capped road end. Edge-owned road and centerline geometry reaches the node.
- **Degree 2:** uncontrolled road seam. Both incident edges terminate at a shared ownership radius,
  endpoint disks are suppressed, one topology-derived connector surface fills the join, and one
  continuous centerline connector follows the turn. Cars proceed without stopping.
- **Degree 3+:** controlled conflict junction. Incident surfaces, shoulders, ditches, wear,
  repairs, puddles, opening effects, and ordinary centerlines terminate before the conflict area.
  One shared junction surface owns the center. Control-specific stop bars and signal markings are
  added by the control renderer.

The connector planner derives its polygon and centerline from incident headings. It never repairs
connections with presentation-only cylinders or coplanar full-road overlays.

### Cached signatures

Each node stores a topology signature (degree, sorted incident edge IDs, and headings), a separate
surface signature (incident completed stages), and its control mode. Only a changed topology
signature or control mode rebuilds connection geometry. A changed surface signature swaps cached
material/visibility without rebuilding incident strips. This enforces the requirement that cleanup
occurs only when a connection or control policy actually changes.

## Junction classification

A pure planner produces a `JunctionPlan` from graph topology:

- node position and degree;
- incident edge IDs and outward headings;
- a degree-2 connector shape, when applicable;
- a major-road pair, when a degree-3+ junction has a clearly most-collinear pair;
- stopped approach edge IDs;
- signal phase groups; and
- stable prop poses for signs, stop bars, and signal poles.

For a clear T-junction, the most-collinear pair is the major road and the remaining approach is the
minor road. If the best pair is not separated clearly from the alternatives, the node is treated
as ambiguous. Ambiguous degree-3 and ordinary degree-4+ junctions use all-way stop control before
promotion.

Degree-2 nodes never receive a stop sign or traffic light, regardless of maturity or nearby
development.

## Slowly evolving control policy

### State

`JunctionControlSim` owns one record per degree-3+ junction:

```ts
interface JunctionControlState {
  nodeId: number;
  x: number;
  z: number;
  mode: 'stop' | 'signal';
  maturitySeconds: number;
  passageEmaPerMinute: number;
}
```

World position is persisted because graph node IDs are reconstructed during restore. Restore maps
saved state through the same canonical quantized coordinate key that `RoadGraph` uses for snapped
node identity.

### Pressure and promotion

The subsystem observes:

- completed car passages through each junction;
- houses within 40 world units; and
- buildings within 40 world units.

It recomputes pressure at a throttled 10-sim-second cadence. The pressure formula is:

```text
passage EMA per minute + 0.5 × nearby houses + 1.5 × nearby buildings
```

When pressure remains at or above 12, maturity accumulates. Below 12, maturity decays at one
quarter of the accumulation rate. Reaching 300 accumulated maturity seconds promotes the junction
to signals. Because low-pressure time decays rather than instantly resets the counter, normal
traffic variation does not erase long-term progress.

Signal promotion is sticky. A signal never demotes because of temporary quiet. Its state is
removed only when topology ceases to define a degree-3+ junction at that position.

Promotion emits `junction:controlChanged`. This event triggers a control-prop rebuild and one
connection cleanup pass so stop bars/signs are replaced cleanly with signal geometry.

## Traffic rules

### Car state

Traffic cars gain explicit approach state:

- target junction node;
- approach edge/lane;
- stopped duration;
- stop-arrival sim time; and
- committed-to-crossing flag.

This state is transient and does not need save persistence because live cars are not restored.

### Uncontrolled degree-2 seams

Degree-2 seams add no gate. Cars follow their route and existing car-following rules continuously
through the node.

### Stop control

- A stopped approach has a stop line 4.5 units before the node.
- The car must reach essentially zero speed and remain stopped for 0.8 sim seconds.
- A clear T-junction does not require the major pair to dwell; those cars still respect junction
  reservations and box clearance.
- Minor and all-way-stop approaches join a deterministic FIFO queue after completing their dwell.
- Earlier stop-arrival time wins; equal timestamps break by lower car ID.
- Permission to proceed still requires the existing single junction lock and clear exit lane.

### Signal control

Signal phases are derived from the planner's opposing/compatible approach groups:

- green: 9 sim seconds;
- yellow: 2 sim seconds; and
- all red: 1 sim second.

The next phase group then receives green. Each junction receives a deterministic coordinate-derived
phase offset so a newly loaded map does not switch every signal simultaneously.

A car that has not committed before yellow stops. A car already committed during green may clear
the junction through yellow/all-red. Red never bypasses the existing lock or box-clearance rules.
Turns are permitted with the incoming approach's green phase; the existing single-slot lock remains
conservative collision authority inside the conflict area.

### Deadlock safety

Existing rules remain active:

- one held lock per car;
- do not block the box;
- lane-scaled lock release;
- stale-lock backoff; and
- lock-free saturation recovery.

Stop/signal permission is an additional gate before lock acquisition, not a replacement for these
safety systems.

## Control rendering

A dedicated `JunctionControlRenderer` owns bounded instanced pools for:

- stop-sign poles;
- octagonal stop-sign faces;
- stop bars;
- signal poles and mast arms; and
- red, yellow, and green emissive heads.

The generic roadside junction-sign placeholder is removed. Other `RoadsideRenderer` furniture is
unchanged.

Stop signs are placed only on approaches identified by the planner. Signal heads face each
incoming approach. Signal materials update from the deterministic phase snapshot without rebuilding
geometry every frame. Geometry rebuild occurs only on connection change or control upgrade.
When a connection is first made, its stop-control instances are planned and cached but remain
hidden until three approaches are painted; that later stage event only toggles visibility.

The renderer uses shared instanced meshes and fixed capacities. It does not create one light source
per signal; emissive materials provide the visible state without shadow-map or point-light cost.

## Living weather

### Weather states

The presentation system supports:

- clear;
- overcast;
- light rain;
- heavy rain; and
- coastal fog.

Weather follows a seeded state machine. Each state has a long dwell interval and transitions over
8–15 sim seconds. Direct clear-to-heavy-rain transitions are disallowed: heavy rain must pass
through overcast or light rain. Coastal fog may transition to/from clear or overcast.

### Unified blended snapshot

`Atmosphere` exposes one read-only snapshot:

```ts
interface WeatherSnapshot {
  kind: WeatherKind;
  cloudCover: number;
  cloudDarkness: number;
  rain: number;
  fog: number;
  wind: number;
  waterRoughness: number;
}
```

During transitions, every field blends from the prior state to the next using the same eased
progress. Consumers never infer weather independently.

The snapshot drives:

- cloud count visibility, opacity, tone, and drift;
- rain streak density and opacity;
- fog near/far distance and fog color;
- sunlight and hemisphere-light attenuation;
- exposure within the existing day/night envelope;
- road wetness and rain-only puddles;
- water roughness/ripple strength;
- restrained tree/grass wind motion; and
- a concise weather line in the Guide.

Fog is clamped to a gameplay visibility floor: the far plane may not fall below 110 world units and
the near plane may not fall below 35 world units. Heavy rain and fog remain visually distinct:
heavy rain has stronger streaks, wetness, wind, and cloud darkness; coastal fog has no rain and
uses softer light with denser distance haze.

Weather has no input path into `TrafficSim`, `BuildQueue`, `GrowthSim`, road routing, vehicle
physics, or construction timing.

### Persistence

Save state records current weather kind, next weather kind, transition progress, and remaining
dwell time. The weather RNG sequence is derived from seed plus a persisted transition index, so
future choices continue deterministically after restore without serializing an opaque RNG closure.

## Save migration

The save schema advances one version and adds:

- `junctionControls`: position-keyed maturity/control records; and
- `weather`: current/next state, blend progress, remaining dwell time, and transition index.

The existing sequential migration chain gains one final step. Older saves receive empty junction
control state and a seeded clear-weather state at their saved time of day. Validation rejects
non-finite numbers and unknown enum values. Stale saved controls with no matching degree-3+ node are
ignored during restore.

## Data flow

```text
RoadGraph topology transaction
  -> roads:connectionsChanged(nodeIds)
  -> junction planner
  -> RoadRenderer dirty-node rebuild
  -> JunctionControlSim state reconciliation
  -> JunctionControlRenderer prop rebuild

TrafficSim junction passage
  -> JunctionControlSim pressure/maturity update
  -> junction:controlChanged (promotion only)
  -> one control-prop + connection cleanup pass

Atmosphere seeded weather state machine
  -> WeatherSnapshot
  -> sky/fog/cloud/rain + road/water/vegetation + Guide
  -> no authoritative simulation consumer
```

## Failure handling

- Missing/stale node IDs in a connection-change event are skipped.
- A degenerate degree-2 connector falls back to the existing edge endpoint treatment rather than
  emitting invalid geometry.
- Malformed junction/weather save data follows existing save validation behavior; migration
  defaults are valid and deterministic.
- A junction with no valid signal phase grouping falls back to all-way stop.
- Instanced control pools clamp to capacity and report bounded counts; they never allocate per
  frame.
- Unknown weather values restore as clear only through migration/defaulting, never through an
  unchecked runtime cast.

## Testing strategy

### Topology and geometry

- Connection-change emits once per commit, split, loop closure, tie-in, and removal transaction.
- Degree-2 joins produce one connector surface and continuous centerline with no endpoint caps,
  stop signs, stop bars, or signal heads.
- Degree-3+ joins rebuild every incident edge exactly once and leave no stale cap, centerline,
  shoulder, ditch, wear, repair, puddle, or opening geometry in the shared conflict area.
- Traffic, settlement, and weather updates do not invoke connection cleanup.
- Control promotion invokes exactly one cleanup.

### Policy and traffic

- Major-pair classification is deterministic for T-junctions and falls back safely for ambiguous
  geometry.
- Pressure accumulation, quarter-speed decay, five-minute promotion, sticky signals, restore, and
  stale-record removal are covered with fixed-step tests.
- Cars complete the 0.8-s stop dwell, respect FIFO tie-breaking, and never cross red before
  commitment.
- Yellow/all-red clearance works for committed cars.
- Degree-2 seams remain ungated.
- Existing lock, box-clearance, short-lane, saturated-ring, determinism, and throughput tests remain
  green, with an additional long mixed stop/signal network soak.

### Weather

- Seeded transition sequences and dwell ranges are deterministic.
- Heavy rain cannot follow clear directly.
- Every snapshot component is continuous and bounded during transitions.
- Fog visibility floors hold in all day/night/weather combinations.
- Clear weather is identity-compatible with existing dry road/water appearance.
- Save round-trip resumes the same transition and produces the same next state.
- A paired traffic/construction run with different weather sequences produces identical sim state.

### Rendering and UX

- Instanced pool counts and orientations match planner output.
- Signal emissive heads match policy phase without geometry rebuilds.
- Restore, topology upgrade, day/night, clear/rain/fog, high/low quality, desktop, and narrow mobile
  visual checks produce no console errors.
- Full Vitest suite and production build pass before deployment.

## Delivery order

1. Add transaction-level connection events and degree-2/degree-3 geometry planning.
2. Add junction policy state, save migration, and slow promotion.
3. Integrate stop/signal rules into traffic and run deadlock/throughput tests.
4. Add instanced stop/signal rendering and remove the generic junction sign.
5. Replace binary rain scheduling with the weather state machine and wire presentation consumers.
6. Add Guide weather status, complete visual/performance verification, update `docs/HANDOFF.md`, and
   deploy.

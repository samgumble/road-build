# Evolving Junction Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add slowly promoted stop/signals that persist with the world, render efficiently, and are obeyed by traffic without weakening existing deadlock protections.

**Architecture:** Extend the pure junction planner with approach policy, add a focused `JunctionControlSim` for demand/maturity, inject it into `TrafficSim`, and render controls through bounded instanced pools. Save V4 reserves both junction-control and weather state so the later weather plan does not require a second migration.

**Tech Stack:** TypeScript, Vitest, Three.js instancing, fixed-step simulation, typed `EventBus`, existing save migration chain.

## Global Constraints

- Degree-2 seams are never stopped or signaled.
- Stop control activates only when three or more incident approaches are painted.
- Signal promotion requires 300 accumulated maturity seconds at pressure ≥12; low pressure decays maturity at 0.25×; signals never demote.
- Clear T-junctions stop only the minor approach; ambiguous 3-way and 4+-way junctions start all-way stop.
- Stop dwell is 0.8 sim seconds at a stop line 4.5u before the node.
- Signal timing is 9s green, 2s yellow, 1s all-red with deterministic coordinate offsets.
- Existing lock, box-clearance, release, backoff, and saturation recovery remain collision authority.
- No per-frame allocation and no per-signal Three.js lights.

## File map

- `src/sim/roads/junctionPlan.ts`: major pair, stopped approaches, phase groups, prop poses.
- `src/sim/traffic/junctionControl.ts`: pressure, maturity, promotion, restore, signal aspect.
- `src/sim/traffic/traffic.ts`: per-car stop/commit state and policy gating.
- `src/core/events.ts`: promotion event.
- `src/core/weather.ts`: shared save-compatible weather types/default reserved for the next plan.
- `src/sim/save.ts`: Save V4 migration and validation.
- `src/render/junctionControlRenderer.ts`: instanced signs, bars, poles, heads, live aspects.
- `src/render/roadsideRenderer.ts`: remove generic junction-sign placeholder.
- `src/main.ts`: construct/update/restore/save/wire systems.
- `tests/junctionPlan.test.ts`, `tests/junctionControl.test.ts`, `tests/traffic.test.ts`, `tests/save.test.ts`, `tests/junctionControlRenderer.test.ts`: focused coverage.

---

### Task 1: Approach policy and signal grouping

**Files:**
- Modify: `src/sim/roads/junctionPlan.ts`
- Modify: `tests/junctionPlan.test.ts`

**Interfaces:**
- Extends `JunctionPlan` with:

```ts
export interface JunctionApproach extends JunctionArm {
  stopX: number; stopZ: number; stopHeading: number;
}
export interface JunctionPlan {
  nodeId: number; x: number; z: number; kind: ConnectionKind;
  arms: JunctionApproach[]; topologySignature: string; surfaceSignature: string;
  majorEdgeIds: number[];
  stoppedEdgeIds: number[];
  signalGroups: number[][];
}
```

- [ ] **Step 1: Write failing planner-policy tests**

Add these deterministic fixtures to `tests/junctionPlan.test.ts`:

```ts
function paint(graph: RoadGraph): void {
  for (const edge of graph.edges.values()) edge.stage = 'painted';
}

function paintedT() {
  const graph = makeGraph();
  const [west] = graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  const [east] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [north] = graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, west, east, north };
}

function paintedThreeArmY() {
  const graph = makeGraph();
  const edgeIds = [
    graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }])[0],
    graph.commitChain([{ x: 0, z: 0 }, { x: -8, z: 16 }])[0],
    graph.commitChain([{ x: 0, z: 0 }, { x: -8, z: -16 }])[0],
  ];
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId, edgeIds };
}

function paintedCorner() {
  const graph = makeGraph();
  graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  paint(graph);
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { graph, nodeId };
}
```

```ts
it('finds the through pair of a clear T and stops only the minor arm', () => {
  const { graph, nodeId, west, east, north } = paintedT();
  const plan = planJunction(graph, nodeId)!;
  expect(plan.majorEdgeIds).toEqual([west, east].sort((a, b) => a - b));
  expect(plan.stoppedEdgeIds).toEqual([north]);
  expect(plan.signalGroups).toEqual([
    [west, east].sort((a, b) => a - b),
    [north],
  ]);
});

it('uses all-way stop and deterministic groups for an ambiguous junction', () => {
  const { graph, nodeId, edgeIds } = paintedThreeArmY();
  const plan = planJunction(graph, nodeId)!;
  expect(plan.majorEdgeIds).toEqual([]);
  expect(plan.stoppedEdgeIds).toEqual([...edgeIds].sort((a, b) => a - b));
  expect(plan.signalGroups.flat().sort((a, b) => a - b)).toEqual([...edgeIds].sort((a, b) => a - b));
});

it('never assigns controls to a degree-two seam', () => {
  const { graph, nodeId } = paintedCorner();
  const plan = planJunction(graph, nodeId)!;
  expect(plan.stoppedEdgeIds).toEqual([]);
  expect(plan.signalGroups).toEqual([]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/junctionPlan.test.ts`

Expected: missing `majorEdgeIds`, `stoppedEdgeIds`, and `signalGroups`.

- [ ] **Step 3: Implement deterministic approach classification**

Normalize angle distance with:

```ts
function oppositeError(a: number, b: number): number {
  const delta = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  return Math.abs(Math.PI - delta);
}
```

Evaluate every arm pair sorted by `(error, lowerEdgeId, higherEdgeId)`. A clear through pair requires
best error ≤15° and either no second candidate or a ≥15° gap to the second-best error. For a clear
T, `majorEdgeIds` is the pair and `stoppedEdgeIds` is every other arm. Otherwise all arms stop.

Signal groups use the major pair as group 1 and remaining arms as group 2. Without a clear pair,
greedily pair arms whose opposite error is ≤20°; every unpaired arm becomes its own group. Sort
edge IDs inside groups and groups by their first ID.

Calculate each stop pose 4.5u outward from the node:

```ts
stopX: node.x + Math.cos(arm.heading) * 4.5,
stopZ: node.z + Math.sin(arm.heading) * 4.5,
stopHeading: arm.heading + Math.PI,
```

- [ ] **Step 4: Run planner tests**

Run: `npx vitest run tests/junctionPlan.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sim/roads/junctionPlan.ts tests/junctionPlan.test.ts
git commit -m "feat(traffic): classify junction approaches and signal groups"
```

---

### Task 2: Slow deterministic junction maturity

**Files:**
- Create: `src/sim/traffic/junctionControl.ts`
- Modify: `src/core/events.ts`
- Create: `tests/junctionControl.test.ts`

**Interfaces:**
- Produces:

```ts
export type JunctionControlMode = 'stop' | 'signal';
export type SignalAspect = 'green' | 'yellow' | 'red';
export interface SavedJunctionControl {
  x: number; z: number; mode: JunctionControlMode;
  maturitySeconds: number; passageEmaPerMinute: number;
}
export interface JunctionControlState extends SavedJunctionControl {
  nodeId: number;
  passagesInWindow: number;
}
export class JunctionControlSim {
  constructor(graph: RoadGraph, bus: EventBus);
  update(dt: number): void;
  recordPassage(nodeId: number): void;
  stateFor(nodeId: number): Readonly<JunctionControlState> | null;
  planFor(nodeId: number): JunctionPlan | null;
  aspectFor(nodeId: number, incomingEdgeId: number): SignalAspect;
  restore(saved: readonly SavedJunctionControl[]): void;
  get saved(): SavedJunctionControl[];
}
```

- Adds event: `'junction:controlChanged': { nodeId: number; mode: 'stop' | 'signal' }`.

- [ ] **Step 1: Write failing maturity and aspect tests**

Create the controller fixture and development helpers in `tests/junctionControl.test.ts`:

```ts
const plannerSampler = (ctrl: P2[]): RoadSample[] => ctrl.map((p) => ({
  x: p.x, y: 1, z: p.z, bridge: false,
}));

function controlledPaintedT() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, plannerSampler);
  const control = new JunctionControlSim(graph, bus);
  const [west] = graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  const [east] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [minorEdge] = graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  for (const edge of graph.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { bus, graph, control, nodeId, majorEdge: west, secondMajorEdge: east, minorEdge };
}

function seedNearbyDevelopment(bus: EventBus, houses: number, buildings: number): void {
  for (let i = 0; i < houses; i++) {
    bus.emit('growth:spawn', { id: i + 1, kind: 'house', x: 8 + i * 0.25, z: 8, rot: 0 });
  }
  for (let i = 0; i < buildings; i++) {
    bus.emit('growth:spawn', { id: 100 + i, kind: 'building', x: -8 - i * 0.25, z: 8, rot: 0 });
  }
}

function removeNearbyDevelopment(bus: EventBus): void {
  for (let i = 1; i <= 8; i++) bus.emit('growth:remove', { id: i });
  for (let i = 0; i < 6; i++) bus.emit('growth:remove', { id: 100 + i });
}

function promote(control: JunctionControlSim, bus: EventBus): void {
  seedNearbyDevelopment(bus, 8, 6);
  for (let i = 0; i < 300; i++) control.update(1);
}
```

```ts
it('promotes only after 300 accumulated high-pressure seconds and never demotes', () => {
  const { control, nodeId, bus } = controlledPaintedT();
  const changed: string[] = [];
  bus.on('junction:controlChanged', ({ mode }) => changed.push(mode));
  seedNearbyDevelopment(bus, 8, 6); // pressure = 4 + 9 = 13 without traffic randomness
  for (let i = 0; i < 299; i++) control.update(1);
  expect(control.stateFor(nodeId)!.mode).toBe('stop');
  control.update(1);
  expect(control.stateFor(nodeId)!.mode).toBe('signal');
  expect(changed).toEqual(['signal']);
  removeNearbyDevelopment(bus);
  for (let i = 0; i < 900; i++) control.update(1);
  expect(control.stateFor(nodeId)!.mode).toBe('signal');
});

it('decays sub-threshold maturity at one quarter speed', () => {
  const { control, nodeId, bus } = controlledPaintedT();
  seedNearbyDevelopment(bus, 8, 6);
  for (let i = 0; i < 100; i++) control.update(1);
  removeNearbyDevelopment(bus);
  for (let i = 0; i < 40; i++) control.update(1);
  expect(control.stateFor(nodeId)!.maturitySeconds).toBeCloseTo(90, 5);
});

it('runs coordinate-offset green/yellow/all-red phases deterministically', () => {
  const { control, nodeId, majorEdge, minorEdge, bus } = controlledPaintedT();
  promote(control, bus);
  const sequence = Array.from({ length: 24 }, () => {
    const value = [control.aspectFor(nodeId, majorEdge), control.aspectFor(nodeId, minorEdge)];
    control.update(1);
    return value;
  });
  expect(sequence.some(([major, minor]) => major === 'green' && minor === 'red')).toBe(true);
  expect(sequence.some(([major, minor]) => major === 'yellow' && minor === 'red')).toBe(true);
  expect(sequence.some(([major, minor]) => major === 'red' && minor === 'green')).toBe(true);
  expect(sequence.some(([major, minor]) => major === 'red' && minor === 'red')).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/junctionControl.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement state reconciliation and pressure**

Maintain settlement records from `growth:spawn`, `growth:upgrade`, and `growth:remove`. Listen to
`roads:connectionsChanged` and reconcile only degree-3+ plans. A state exists only when at least
three arms are painted; prior to that `stateFor` returns `null` while `planFor` still returns the
cached geometry plan. Listen to `construction:stage` to reconcile this activation; it does not emit
`roads:connectionsChanged` or trigger geometry cleanup.

Every 10 accumulated seconds:

```ts
const ratePerMinute = passagesInWindow * 6;
state.passageEmaPerMinute = state.passageEmaPerMinute * 0.75 + ratePerMinute * 0.25;
const pressure = state.passageEmaPerMinute + houses * 0.5 + buildings * 1.5;
state.maturitySeconds = pressure >= 12
  ? Math.min(300, state.maturitySeconds + 10)
  : Math.max(0, state.maturitySeconds - 2.5);
```

Promote on crossing 300 and emit once. Signal cycle duration is `(9 + 2 + 1) * groupCount`. Hash
the canonical node coordinate to an integer offset modulo cycle duration. `aspectFor` returns red
for unknown edges or the all-red second; returns yellow only during the active group's 2s yellow.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/junctionControl.test.ts tests/junctionPlan.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sim/traffic/junctionControl.ts src/core/events.ts tests/junctionControl.test.ts
git commit -m "feat(traffic): evolve stop junctions into deterministic signals"
```

---

### Task 3: Save V4 migration and restore

**Files:**
- Create: `src/core/weather.ts`
- Modify: `src/sim/save.ts`
- Modify: `src/main.ts`
- Modify: `tests/save.test.ts`

**Interfaces:**
- Produces `SaveV4` with `junctionControls` and reserved `weather`.
- Produces shared weather definitions:

```ts
export type WeatherKind = 'clear' | 'overcast' | 'light-rain' | 'heavy-rain' | 'coastal-fog';
export interface WeatherSaveState {
  current: WeatherKind; next: WeatherKind;
  transition: number; remaining: number; transitionIndex: number;
}
export const DEFAULT_WEATHER_SAVE: WeatherSaveState = {
  current: 'clear', next: 'clear', transition: 1, remaining: 120, transitionIndex: 0,
};
```

- [ ] **Step 1: Write failing V3→V4 and round-trip tests**

```ts
it('migrates v3 with empty controls and deterministic clear weather defaults', () => {
  const v3 = {
    version: 3, seed: 'v3-fixture', timeOfDay: 0.35, edges: [],
    growth: { dev: [], spawned: [], decay: [] }, quarry: null,
  };
  const migrated = deserialize(JSON.stringify(v3))!;
  expect(migrated.version).toBe(4);
  expect(migrated.junctionControls).toEqual([]);
  expect(migrated.weather).toEqual(DEFAULT_WEATHER_SAVE);
});

it('round-trips persisted signal maturity and weather reservation', () => {
  const world = freshWorld('v4-round-trip');
  const junctionControls = [{
    x: 16, z: 0, mode: 'signal', maturitySeconds: 300, passageEmaPerMinute: 9,
  }] as const;
  const weather = { current: 'overcast', next: 'light-rain', transition: 0.4, remaining: 31, transitionIndex: 4 } as const;
  const save = deserialize(serialize({
    seed: 'v4-round-trip', timeOfDay: 0.4, graph: world.graph, growth: world.growth,
    quarry: world.quarry, junctionControls, weather,
  }))!;
  expect(save.junctionControls).toEqual(junctionControls);
  expect(save.weather).toEqual(weather);
});
```

- [ ] **Step 2: Run save tests and verify RED**

Run: `npx vitest run tests/save.test.ts`

Expected: saves remain version 3 and fields are absent.

- [ ] **Step 3: Implement V4 shape, validation, and migration**

Set `SAVE_VERSION = 4`. Keep V1/V2/V3 interfaces unchanged and add `SaveV4`. Add strict validators:

```ts
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function validControl(value: unknown): value is SavedJunctionControl {
  const c = value as Partial<SavedJunctionControl>;
  return finite(c.x) && finite(c.z) && (c.mode === 'stop' || c.mode === 'signal')
    && finite(c.maturitySeconds) && c.maturitySeconds! >= 0 && c.maturitySeconds! <= 300
    && finite(c.passageEmaPerMinute) && c.passageEmaPerMinute! >= 0;
}

function validWeather(value: unknown): value is WeatherSaveState {
  const w = value as Partial<WeatherSaveState>;
  return (WEATHER_KINDS as readonly unknown[]).includes(w.current)
    && (WEATHER_KINDS as readonly unknown[]).includes(w.next)
    && finite(w.transition) && w.transition! >= 0 && w.transition! <= 1
    && finite(w.remaining) && w.remaining! >= 0
    && Number.isInteger(w.transitionIndex) && w.transitionIndex! >= 0;
}
```

V3 migration adds `junctionControls: []` and `{ ...DEFAULT_WEATHER_SAVE }`. Update
`SerializableWorld`, `serialize`, and `deserialize` return type. Update every pre-existing test that
asserts the latest serialized version from 3 to 4; leave explicit V1/V2/V3 migration fixtures at
their historical versions.

Construct `JunctionControlSim` before `TrafficSim` in `main.ts`; pass it to traffic. After graph/
growth restore, call `junctionControl.restore(save.junctionControls)`. Update it once per fixed
step after `traffic.update`. Save `junctionControl.saved` and `DEFAULT_WEATHER_SAVE` until the
weather plan replaces the default with live atmosphere state.

- [ ] **Step 4: Run migration/full save tests**

Run: `npx vitest run tests/save.test.ts tests/restoreRender.test.ts && npx tsc --noEmit`

Expected: all pass; V1→V2→V3→V4 chain remains explicit.

- [ ] **Step 5: Commit**

```bash
git add src/core/weather.ts src/sim/save.ts src/main.ts tests/save.test.ts
git commit -m "feat(save): persist evolving junction controls in v4 worlds"
```

---

### Task 4: Traffic stop and signal compliance

**Files:**
- Modify: `src/sim/traffic/traffic.ts`
- Modify: `tests/traffic.test.ts`

**Interfaces:**
- Consumes: `JunctionControlSim.planFor`, `stateFor`, and `aspectFor`.
- `TrafficSim` constructor becomes `(graph, bus, rng, junctionControl?)`; production passes the
  controller, while legacy isolated tests without one retain uncontrolled behavior.

- [ ] **Step 1: Write failing behavior tests**

Use real graphs, fixed-step updates, and deterministic car injection via the existing structural
test pattern already used by traffic deadlock tests:

```ts
function controlledTrafficT() {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  const control = new JunctionControlSim(g, bus);
  const [west] = g.commitChain([{ x: -24, z: 0 }, { x: 0, z: 0 }]);
  const [east] = g.commitChain([{ x: 0, z: 0 }, { x: 24, z: 0 }]);
  const [minor] = g.commitChain([{ x: 0, z: 0 }, { x: 0, z: 24 }]);
  for (const edge of g.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  bus.emit('roads:changed', {});
  const traffic = new TrafficSim(g, bus, createRng('controlled-t'), control);
  traffic.targetPopulation = 0;
  const nodeId = [...g.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { bus, g, control, traffic, nodeId, west, east, minor };
}

function injectApproachCar(
  world: ReturnType<typeof controlledTrafficT>, edgeId: number,
  options: { distToNode: number; speed: number },
) {
  const internal = world.traffic as unknown as { lg: LaneGraph; cs: any[] };
  const lane = [...internal.lg.lanes.values()].find((l) => l.edgeId === edgeId && l.to === world.nodeId)!;
  const next = [...internal.lg.lanes.values()].find((l) => l.from === world.nodeId && l.edgeId !== edgeId)!;
  const car = {
    id: 9000 + internal.cs.length, route: [lane, next], routeIndex: 0, laneId: lane.id,
    s: lane.length - options.distToNode, speed: options.speed, color: 0x888888,
    heldNodeId: null, stalledHeldSeconds: 0, lockBackoffUntil: 0, boxBlockedSeconds: 0,
    stopDwell: 0, stopArrivedAt: null, approachNodeId: null, committedNodeId: null,
  };
  internal.cs.push(car);
  return car;
}

function injectMinorApproachCar(world: ReturnType<typeof controlledTrafficT>, options: { distToNode: number; speed: number }) {
  return injectApproachCar(world, world.minor, options);
}

function injectMajorApproachCar(world: ReturnType<typeof controlledTrafficT>, options: { distToNode: number; speed: number }) {
  return injectApproachCar(world, world.west, options);
}

function advanceToAspect(world: ReturnType<typeof controlledTrafficT>, laneId: number, aspect: SignalAspect): void {
  const internal = world.traffic as unknown as { lg: LaneGraph };
  const edgeId = internal.lg.lanes.get(laneId)!.edgeId;
  for (let i = 0; i < 100; i++) {
    if (world.control.aspectFor(world.nodeId, edgeId) === aspect) return;
    world.control.update(0.25);
  }
  throw new Error(`aspect ${aspect} not reached`);
}

function promotedSignalTrafficT() {
  const world = controlledTrafficT();
  seedTrafficControlDevelopment(world.bus);
  for (let i = 0; i < 300; i++) world.control.update(1);
  return world;
}

function seedTrafficControlDevelopment(bus: EventBus): void {
  for (let i = 0; i < 8; i++) {
    bus.emit('growth:spawn', { id: i + 1, kind: 'house', x: 8, z: 8 + i * 0.2, rot: 0 });
  }
  for (let i = 0; i < 6; i++) {
    bus.emit('growth:spawn', { id: 100 + i, kind: 'building', x: -8, z: 8 + i * 0.2, rot: 0 });
  }
}

function paintedLoopTrafficWithControl() {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  const control = new JunctionControlSim(g, bus);
  g.commitChain([
    { x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 24 },
    { x: 0, z: 24 }, { x: 0, z: 0 },
  ]);
  for (const edge of g.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  bus.emit('roads:changed', {});
  const traffic = new TrafficSim(g, bus, createRng('controlled-loop'), control);
  traffic.targetPopulation = 0;
  return { bus, g, control, traffic };
}

function injectLoopCar(world: ReturnType<typeof paintedLoopTrafficWithControl>) {
  const internal = world.traffic as unknown as { lg: LaneGraph; cs: any[] };
  const lane = [...internal.lg.lanes.values()][0];
  const next = [...internal.lg.lanes.values()].find((l) => l.from === lane.to && l.edgeId !== lane.edgeId)!;
  const car = {
    id: 9900, route: [lane, next], routeIndex: 0, laneId: lane.id, s: lane.length - 2,
    speed: 3, color: 0x888888, heldNodeId: null, stalledHeldSeconds: 0,
    lockBackoffUntil: 0, boxBlockedSeconds: 0, stopDwell: 0, stopArrivedAt: null,
    approachNodeId: null, committedNodeId: null,
  };
  internal.cs.push(car);
  return car;
}
```

```ts
it('holds a minor-road car for a complete 0.8 second stop before lock acquisition', () => {
  const world = controlledTrafficT();
  const car = injectMinorApproachCar(world, { distToNode: 4.5, speed: 0 });
  for (let i = 0; i < 47; i++) world.traffic.update(1 / 60, 0.4);
  expect(car.heldNodeId).toBeNull();
  world.traffic.update(1 / 60, 0.4);
  expect(car.stopDwell).toBeGreaterThanOrEqual(0.8);
  expect(car.heldNodeId).toBe(world.nodeId);
});

it('lets major T traffic proceed without stop dwell while retaining the lock rule', () => {
  const world = controlledTrafficT();
  const car = injectMajorApproachCar(world, { distToNode: 4, speed: 2 });
  world.traffic.update(1 / 60, 0.4);
  expect(car.stopDwell).toBe(0);
  expect(car.heldNodeId).toBe(world.nodeId);
});

it('holds red approaches and lets a green committed car clear yellow', () => {
  const world = promotedSignalTrafficT();
  const red = injectMinorApproachCar(world, { distToNode: 4.5, speed: 0 });
  advanceToAspect(world, red.laneId, 'red');
  world.traffic.update(1 / 60, 0.4);
  expect(red.heldNodeId).toBeNull();
  const green = injectMajorApproachCar(world, { distToNode: 3, speed: 2 });
  advanceToAspect(world, green.laneId, 'green');
  world.traffic.update(1 / 60, 0.4);
  expect(green.heldNodeId).toBe(world.nodeId);
  advanceToAspect(world, green.laneId, 'yellow');
  expect(green.committedNodeId).toBe(world.nodeId);
});

it('never gates a degree-two loop seam', () => {
  const world = paintedLoopTrafficWithControl();
  const car = injectLoopCar(world);
  for (let i = 0; i < 120; i++) world.traffic.update(1 / 60, 0.4);
  expect(car.stopDwell).toBe(0);
  expect(car.routeIndex).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/traffic.test.ts`

Expected: car stop fields are absent and cars acquire locks without policy gates.

- [ ] **Step 3: Add per-car approach state and braking cap**

Extend `Car`:

```ts
stopDwell: number;
stopArrivedAt: number | null;
approachNodeId: number | null;
committedNodeId: number | null;
```

Initialize/reset fields at spawn and route transition. Before the existing acquisition block,
resolve the incoming edge policy. Start policy braking 12u before the node, targeting the 4.5u
line without changing `DECEL`:

```ts
const stopDistance = Math.max(0, distToLaneEnd - 4.5);
const stoppingCap = Math.sqrt(2 * DECEL * stopDistance);
targetSpeed = Math.min(targetSpeed, stoppingCap);
```

At `distToLaneEnd <= 4.7` and `speed < STALE_SPEED_EPS`, accumulate dwell. Set arrival time exactly
once when dwell reaches 0.8.

For stop queues, scan cars targeting the same node whose dwell is complete; choose smallest
`stopArrivedAt`, then smallest car ID. Major T edges bypass dwell. For signals, permit green;
permit yellow only when `committedNodeId === nodeId`; block red. Set `committedNodeId` when the
junction lock is acquired.

Pass policy permission into the existing condition as another AND gate:

```ts
const canAcquire = notHoldingAnother && backoffClear && policyAllows && (exitClear || forceOverride);
```

Never let `forceOverride` bypass `policyAllows`.

When a car crosses into the next lane, call `junctionControl.recordPassage(previousLane.to)` and
reset stop state. Clear `committedNodeId` when the previous junction lock is released.

- [ ] **Step 4: Run traffic and deadlock tests**

Run: `npx vitest run tests/traffic.test.ts tests/lanes.test.ts`

Expected: new compliance tests and every existing deadlock/throughput test pass.

- [ ] **Step 5: Commit**

```bash
git add src/sim/traffic/traffic.ts tests/traffic.test.ts
git commit -m "feat(traffic): obey stop signs and traffic signals"
```

---

### Task 5: Instanced stop signs and traffic lights

**Files:**
- Create: `src/render/junctionControlRenderer.ts`
- Modify: `src/render/roadsideRenderer.ts`
- Modify: `src/main.ts`
- Create: `tests/junctionControlRenderer.test.ts`
- Modify: `tests/roadsideRenderer.test.ts`

**Interfaces:**
- Consumes: `JunctionControlSim.planFor/stateFor/aspectFor`, graph, terrain, events.
- Produces: one group named `junction-controls` with bounded instanced pools.
- Produces class API:

```ts
export class JunctionControlRenderer {
  constructor(scene: THREE.Scene, graph: RoadGraph, terrain: TerrainProbe,
    control: JunctionControlSim, bus: EventBus);
  rebuild(nodeIds?: readonly number[]): void;
  update(): void;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing renderer tests**

Use these fixtures in `tests/junctionControlRenderer.test.ts`:

```ts
const terrain = { heightAt: () => 0, isLand: () => true };
const plannerSampler = (ctrl: P2[]): RoadSample[] => ctrl.map((p) => ({
  x: p.x, y: 1, z: p.z, bridge: false,
}));

function renderedControlledT() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, plannerSampler);
  const control = new JunctionControlSim(graph, bus);
  const scene = new THREE.Scene();
  const renderer = new JunctionControlRenderer(scene, graph, terrain, control, bus);
  graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [minorEdge] = graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  for (const edge of graph.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  const nodeId = [...graph.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
  return { scene, bus, graph, control, renderer, nodeId, minorEdge };
}

function forcePromote(control: JunctionControlSim, bus: EventBus): void {
  for (let i = 0; i < 8; i++) {
    bus.emit('growth:spawn', { id: i + 1, kind: 'house', x: 8, z: 8 + i * 0.2, rot: 0 });
  }
  for (let i = 0; i < 6; i++) {
    bus.emit('growth:spawn', { id: 100 + i, kind: 'building', x: -8, z: 8 + i * 0.2, rot: 0 });
  }
  for (let i = 0; i < 300; i++) control.update(1);
}

function renderedPromotedT() {
  const fixture = renderedControlledT();
  forcePromote(fixture.control, fixture.bus);
  return fixture;
}

function renderedDegreeTwoSeam() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, plannerSampler);
  const control = new JunctionControlSim(graph, bus);
  const scene = new THREE.Scene();
  const renderer = new JunctionControlRenderer(scene, graph, terrain, control, bus);
  graph.commitChain([{ x: -16, z: 0 }, { x: 0, z: 0 }]);
  graph.commitChain([{ x: 0, z: 0 }, { x: 0, z: 16 }]);
  for (const edge of graph.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  return { scene, renderer };
}
```

```ts
it('renders only the minor stop approach at a clear painted T', () => {
  const { scene, renderer } = renderedControlledT();
  renderer.rebuild();
  const group = scene.getObjectByName('junction-controls')!;
  expect((group.getObjectByName('junction-stop-faces') as THREE.InstancedMesh).count).toBe(1);
  expect((group.getObjectByName('junction-stop-bars') as THREE.InstancedMesh).count).toBe(1);
  expect((group.getObjectByName('junction-signal-housings') as THREE.InstancedMesh).count).toBe(0);
});

it('replaces stop instances with signal heads on promotion', () => {
  const { scene, bus, control } = renderedControlledT();
  const group = scene.getObjectByName('junction-controls')!;
  const stopGeometry = (group.getObjectByName('junction-stop-faces') as THREE.InstancedMesh).geometry;
  bus.emit('growth:spawn', { id: 99, kind: 'building', x: 4, z: 4, rot: 0 });
  expect((group.getObjectByName('junction-stop-faces') as THREE.InstancedMesh).geometry).toBe(stopGeometry);
  forcePromote(control, bus);
  expect((group.getObjectByName('junction-stop-faces') as THREE.InstancedMesh).count).toBe(0);
  expect((group.getObjectByName('junction-signal-housings') as THREE.InstancedMesh).count).toBe(3);
});

it('changes signal lens visibility without rebuilding geometry', () => {
  const { scene, control, renderer } = renderedPromotedT();
  const group = scene.getObjectByName('junction-controls')!;
  const lensMeshes = ['red', 'yellow', 'green'].map((color) =>
    group.getObjectByName(`junction-signal-${color}`) as THREE.InstancedMesh);
  const before = lensMeshes.map((mesh) => mesh.geometry);
  control.update(10);
  renderer.update();
  expect(lensMeshes.map((mesh) => mesh.geometry)).toEqual(before);
  expect(lensMeshes.reduce((sum, mesh) => sum + mesh.count, 0)).toBe(9);
});

it('renders no traffic controls at a degree-two road seam', () => {
  const { scene } = renderedDegreeTwoSeam();
  const group = scene.getObjectByName('junction-controls')!;
  expect(group.children.every((child) => (child as THREE.InstancedMesh).count === 0)).toBe(true);
});
```

Use existing render-stat getter conventions; do not expose mutable pools.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/junctionControlRenderer.test.ts tests/roadsideRenderer.test.ts`

Expected: renderer module absent; roadside still contains two generic sign pools.

- [ ] **Step 3: Implement bounded instanced pools**

Create shared pools for pole, octagonal stop face, stop bar, signal pole, mast arm, housing, and
three lens colors. Use `CylinderGeometry(0.45, 0.45, 0.08, 8)` rotated to face traffic for the stop
face and `BoxGeometry` for bars/poles/housings.

Name the pools exactly `junction-stop-poles`, `junction-stop-faces`, `junction-stop-bars`,
`junction-signal-poles`, `junction-signal-masts`, `junction-signal-housings`, and
`junction-signal-red|yellow|green` so tests and browser diagnostics can inspect bounded counts
without test-only APIs.

At connection change or `junction:controlChanged`, rebuild matrices from planner poses. At routine
stage events, toggle counts/scale for cached stop geometry when the third approach becomes painted.
At each render update, keep signal geometry fixed and update only lens instance matrices: active
lens scale 1, inactive lens scale 0.18. Use unlit `MeshBasicMaterial` for lenses; do not allocate
lights.

Remove `signs` from `RoadsidePlan` and its two generic pools. Update the existing pool-count test
from 10 to 8 and assert `'signs' in plan` is false.

Wire renderer construction after `RoadsideRenderer` in `main.ts`; call `update()` after
`carRenderer.update`; dispose with other renderers if a teardown path exists.

- [ ] **Step 4: Run renderer and full tests**

Run: `npx vitest run tests/junctionControlRenderer.test.ts tests/roadsideRenderer.test.ts tests/roadContinuity.test.ts`

Then: `npm test && npm run build`

Expected: all pass; draw calls remain below 250 in live stats.

- [ ] **Step 5: Commit**

```bash
git add src/render/junctionControlRenderer.ts src/render/roadsideRenderer.ts src/main.ts tests/junctionControlRenderer.test.ts tests/roadsideRenderer.test.ts
git commit -m "feat(render): add evolving stop signs and traffic signals"
```

---

### Task 6: Mixed-control soak, UX verification, and handoff

**Files:**
- Modify: `tests/traffic.test.ts`
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: complete policy/traffic/render system.
- Produces: deploy-ready traffic-control slice.

- [ ] **Step 1: Add a failing-before-fix long mixed-control throughput test during Task 4**

Keep this test in the final suite:

```ts
function mixedControlGrid(seed: string) {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  const control = new JunctionControlSim(g, bus);
  const coords = [-24, 0, 24];
  for (const z of coords) {
    for (let i = 0; i < coords.length - 1; i++) {
      g.commitChain([{ x: coords[i], z }, { x: coords[i + 1], z }]);
    }
  }
  for (const x of coords) {
    for (let i = 0; i < coords.length - 1; i++) {
      g.commitChain([{ x, z: coords[i] }, { x, z: coords[i + 1] }]);
    }
  }
  for (const edge of g.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
  bus.emit('roads:changed', {});
  control.restore([{
    x: 0, z: 0, mode: 'signal', maturitySeconds: 300, passageEmaPerMinute: 12,
  }]);
  const traffic = new TrafficSim(g, bus, createRng(seed), control);
  return { bus, g, control, traffic };
}

it('keeps trips completing for 6 sim minutes across stop and signal junctions', () => {
  const world = mixedControlGrid('mixed-control-soak');
  world.traffic.targetPopulation = 32;
  let completions = 0;
  let previousIds = new Set(world.traffic.cars.map((c) => c.id));
  for (let tick = 0; tick < 6 * 60 * 60; tick++) {
    world.traffic.update(1 / 60, 0.5);
    world.control.update(1 / 60);
    const ids = new Set(world.traffic.cars.map((c) => c.id));
    for (const id of previousIds) if (!ids.has(id)) completions++;
    previousIds = ids;
  }
  expect(completions).toBeGreaterThan(18);
});
```

Run it once against the pre-Task-4 traffic implementation to record the expected failure (cars do
not obey controls), then retain it through GREEN.

- [ ] **Step 2: Perform live policy checks**

Verify clear T, ambiguous 3-way, 4-way, loop seam, signal promotion, save/reload, red/yellow/all-red,
night emissive heads, and narrow mobile framing. Confirm no generic duplicate junction signs.

- [ ] **Step 3: Measure draw calls and frame behavior**

Use a dense map with at least 12 controlled junctions. Verify high/low tiers stay under 250 draw
calls and no per-frame `InstancedMesh`/material allocation appears in a short profiler capture.

- [ ] **Step 4: Final checks and documentation**

Run:

```bash
npm test
npm run build
git diff --check
git status --short
```

Update `docs/HANDOFF.md` with Save V4, policy thresholds, signal timing, renderer ownership, and
the rule that weather never enters simulation.

- [ ] **Step 5: Commit**

```bash
git add tests/traffic.test.ts docs/HANDOFF.md
git commit -m "test: soak evolving junction controls under traffic"
```

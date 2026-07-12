# Road Connection Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild every affected road end exactly once when topology changes, using shared degree-2 seam geometry and degree-3+ junction geometry without stale caps or overlapping markings.

**Architecture:** `RoadGraph` emits one transaction-level connection event containing affected nodes. A pure junction planner classifies node geometry. `RoadRenderer` caches topology signatures, rebuilds only incident edge endpoints, and owns degree-2 seams plus degree-3+ conflict surfaces.

**Tech Stack:** TypeScript, Three.js, Vitest, existing typed `EventBus` and `RoadGraph`.

## Global Constraints

- Cleanup runs only after topology transactions or later control upgrades—not per car, growth event, weather update, or frame.
- Degree 1 keeps an ordinary cap; degree 2 is an uncontrolled seam; degree 3+ is a conflict junction.
- Every final surface/detail layer has exactly one owner inside a connection area.
- Existing bridge-approach ownership and construction-stage rendering remain intact.
- No save migration is required in this plan.
- Preserve deterministic graph behavior and existing event contracts.

## File map

- `src/core/events.ts`: declares the additive transaction-level event.
- `src/sim/roads/graph.ts`: batches affected nodes and emits once per public topology mutation.
- `src/sim/roads/junctionPlan.ts`: pure degree/heading/signature planner; no Three.js imports.
- `src/render/roadRenderer.ts`: consumes plans, rebuilds dirty incident edges, and owns seam/junction meshes.
- `tests/graph.test.ts`: event cardinality and payload coverage.
- `tests/junctionPlan.test.ts`: pure classification and signature tests.
- `tests/roadContinuity.test.ts`: geometry ownership and no-spurious-rebuild integration tests.

---

### Task 1: Transaction-level connection events

**Files:**
- Modify: `src/core/events.ts`
- Modify: `src/sim/roads/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Produces: `'roads:connectionsChanged': { nodeIds: number[] }`
- Contract: one sorted, deduplicated payload after each successful public `commitChain`, `splitEdge`, or `removeEdge` transaction.

- [ ] **Step 1: Write failing graph-event tests**

Append tests that collect payloads and cover simple commit, interior split/tie-in, loop closure, and removal:

```ts
it('emits one connection transaction with every affected surviving node', () => {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, stubSampler);
  const changes: number[][] = [];
  bus.on('roads:connectionsChanged', ({ nodeIds }) => changes.push(nodeIds));

  graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
  changes.length = 0;
  graph.commitChain([{ x: 16, z: 0 }, { x: 16, z: 24 }]);

  expect(changes).toHaveLength(1);
  const junction = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
  expect(changes[0]).toContain(junction.id);
  expect(new Set(changes[0]).size).toBe(changes[0].length);
  expect(changes[0]).toEqual([...changes[0]].sort((a, b) => a - b));
});

it('emits one transaction for a closed loop and one for removal', () => {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, stubSampler);
  const changes: number[][] = [];
  bus.on('roads:connectionsChanged', ({ nodeIds }) => changes.push(nodeIds));
  const ids = graph.commitChain([
    { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 },
    { x: 0, z: 16 }, { x: 0, z: 0 },
  ]);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toHaveLength(2);
  changes.length = 0;
  graph.removeEdge(ids[0]);
  expect(changes).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/graph.test.ts`

Expected: TypeScript/test failure because `roads:connectionsChanged` is not in `GameEvents` and no payload is emitted.

- [ ] **Step 3: Add the event and transaction collector**

Add to `GameEvents`:

```ts
'roads:connectionsChanged': { nodeIds: number[] };
```

Add transaction state to `RoadGraph`:

```ts
private connectionTxnDepth = 0;
private affectedConnectionNodes = new Set<number>();

private beginConnectionTransaction(): void {
  this.connectionTxnDepth++;
}

private touchConnection(...nodeIds: number[]): void {
  for (const id of nodeIds) if (this.nodes.has(id)) this.affectedConnectionNodes.add(id);
}

private endConnectionTransaction(): void {
  this.connectionTxnDepth--;
  if (this.connectionTxnDepth !== 0) return;
  const nodeIds = [...this.affectedConnectionNodes]
    .filter((id) => this.nodes.has(id))
    .sort((a, b) => a - b);
  this.affectedConnectionNodes.clear();
  if (nodeIds.length) this.bus.emit('roads:connectionsChanged', { nodeIds });
}
```

Wrap public mutations in `try/finally`. `commitChain` starts/ends one transaction; nested split helpers call `touchConnection` but do not emit. `splitEdge` starts its own transaction for direct callers. `removeEdge` captures `e.a/e.b`, mutates, then touches surviving endpoint nodes before ending.

Use this pattern:

```ts
commitChain(rawCtrl: P2[]): number[] {
  this.beginConnectionTransaction();
  try {
    return this.commitChainBody(rawCtrl);
  } finally {
    this.endConnectionTransaction();
  }
}
```

Extract the current body verbatim to `private commitChainBody(rawCtrl: P2[]): number[]`. In `makeEdge`, call `touchConnection(a, b)`. In `replaceEdgeWithSplit`, call `touchConnection(e.a, id, e.b)`. This makes nested operations additive while the outermost boundary emits once.

- [ ] **Step 4: Run graph tests and full typecheck**

Run: `npx vitest run tests/graph.test.ts && npx tsc --noEmit`

Expected: all graph tests pass; no event payload type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/events.ts src/sim/roads/graph.ts tests/graph.test.ts
git commit -m "feat(roads): emit connection changes once per topology transaction"
```

---

### Task 2: Pure degree-2/degree-3 junction planning

**Files:**
- Create: `src/sim/roads/junctionPlan.ts`
- Create: `tests/junctionPlan.test.ts`

**Interfaces:**
- Consumes: `RoadGraph`, `RoadEdge`, node ID.
- Produces:

```ts
export type ConnectionKind = 'end' | 'seam' | 'junction';
export interface JunctionArm { edgeId: number; heading: number; stage: Stage; }
export interface JunctionPlan {
  nodeId: number; x: number; z: number; kind: ConnectionKind;
  arms: JunctionArm[]; topologySignature: string; surfaceSignature: string;
}
export function planJunction(graph: RoadGraph, nodeId: number): JunctionPlan | null;
```

- [ ] **Step 1: Write failing planner tests**

Create `tests/junctionPlan.test.ts` with these imports/helpers, then the tests below:

```ts
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';
import { RoadGraph } from '../src/sim/roads/graph';
import { planJunction } from '../src/sim/roads/junctionPlan';

const plannerSampler = (ctrl: P2[]): RoadSample[] => ctrl.map((p) => ({
  x: p.x, y: 1, z: p.z, bridge: false,
}));

function makeGraph(): RoadGraph {
  return new RoadGraph(new EventBus(), plannerSampler);
}
```

Tests:

```ts
it('classifies tied road ends as an uncontrolled seam', () => {
  const graph = makeGraph();
  graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  graph.commitChain([{ x: 16, z: 0 }, { x: 24, z: 8 }]);
  const node = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
  const plan = planJunction(graph, node.id)!;
  expect(plan.kind).toBe('seam');
  expect(plan.arms).toHaveLength(2);
});

it('classifies loop split nodes as seams and T nodes as junctions', () => {
  const loop = makeGraph();
  loop.commitChain([
    { x: 0, z: 0 }, { x: 16, z: 0 }, { x: 16, z: 16 },
    { x: 0, z: 16 }, { x: 0, z: 0 },
  ]);
  for (const node of loop.nodes.values()) expect(planJunction(loop, node.id)!.kind).toBe('seam');

  const tee = makeGraph();
  tee.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
  tee.commitChain([{ x: 16, z: 0 }, { x: 16, z: 24 }]);
  const node = [...tee.nodes.values()].find((n) => tee.edgesAtNode(n.id).length === 3)!;
  expect(planJunction(tee, node.id)!.kind).toBe('junction');
});

it('separates stable topology identity from stage-only surface state', () => {
  const graph = makeGraph();
  const [a] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [b] = graph.commitChain([{ x: 16, z: 0 }, { x: 24, z: 8 }]);
  const node = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
  const before = planJunction(graph, node.id)!;
  graph.edges.get(a)!.stage = 'painted';
  const after = planJunction(graph, node.id)!;
  expect(after.topologySignature).toBe(before.topologySignature);
  expect(after.surfaceSignature).not.toBe(before.surfaceSignature);
  expect(after.arms.map((arm) => arm.edgeId)).toEqual([a, b].sort((x, y) => x - y));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/junctionPlan.test.ts`

Expected: module-not-found failure for `junctionPlan.ts`.

- [ ] **Step 3: Implement the pure planner**

Use endpoint samples to calculate outward headings:

```ts
function armFor(edge: RoadEdge, nodeId: number): JunctionArm | null {
  if (edge.samples.length < 2) return null;
  const atA = edge.a === nodeId;
  if (!atA && edge.b !== nodeId) return null;
  const origin = atA ? edge.samples[0] : edge.samples[edge.samples.length - 1];
  const next = atA ? edge.samples[1] : edge.samples[edge.samples.length - 2];
  return { edgeId: edge.id, heading: Math.atan2(next.z - origin.z, next.x - origin.x), stage: edge.stage };
}

export function planJunction(graph: RoadGraph, nodeId: number): JunctionPlan | null {
  const node = graph.nodes.get(nodeId);
  if (!node) return null;
  const arms = graph.edgesAtNode(nodeId)
    .map((id) => armFor(graph.edges.get(id)!, nodeId))
    .filter((arm): arm is JunctionArm => arm !== null)
    .sort((a, b) => a.edgeId - b.edgeId);
  const kind: ConnectionKind = arms.length <= 1 ? 'end' : arms.length === 2 ? 'seam' : 'junction';
  const topologySignature = `${kind}|${arms.map((a) => `${a.edgeId}:${a.heading.toFixed(5)}`).join('|')}`;
  const surfaceSignature = arms.map((a) => `${a.edgeId}:${a.stage}`).join('|');
  return { nodeId, x: node.x, z: node.z, kind, arms, topologySignature, surfaceSignature };
}
```

- [ ] **Step 4: Run planner tests**

Run: `npx vitest run tests/junctionPlan.test.ts`

Expected: all planner tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sim/roads/junctionPlan.ts tests/junctionPlan.test.ts
git commit -m "feat(roads): classify connection seams and junctions"
```

---

### Task 3: Shared degree-2 seam geometry

**Files:**
- Modify: `src/render/roadRenderer.ts`
- Test: `tests/roadContinuity.test.ts`

**Interfaces:**
- Consumes: `planJunction(graph, nodeId)` and `roads:connectionsChanged`.
- Produces: seam meshes tagged `roadDetail='connectionSurface'` and `roadDetail='connectionCenterline'`.

- [ ] **Step 1: Replace the old degree-2 cap expectation with failing ownership tests**

Add these fixtures beside the existing `junctionSampler` in `tests/roadContinuity.test.ts`:

```ts
function renderedConnections() {
  const bus = new EventBus();
  const graph = new RoadGraph(bus, junctionSampler);
  const scene = new THREE.Scene();
  const renderer = new RoadRenderer(scene, graph, bus, new Heightfield('connection-fixture', bus));
  return { bus, graph, scene, renderer };
}

function paintAll(bus: EventBus, graph: RoadGraph): void {
  for (const edge of graph.edges.values()) {
    edge.stage = 'painted';
    bus.emit('construction:stage', { edgeId: edge.id, stage: 'painted', crew: 0 });
  }
}

function renderedCorner() {
  const fixture = renderedConnections();
  fixture.graph.commitChain([{ x: 0, z: 0 }, { x: 24, z: 0 }]);
  fixture.graph.commitChain([{ x: 24, z: 0 }, { x: 40, z: 16 }]);
  paintAll(fixture.bus, fixture.graph);
  return fixture;
}

function renderedPaintedLoop() {
  const fixture = renderedConnections();
  fixture.graph.commitChain([
    { x: 0, z: 0 }, { x: 24, z: 0 }, { x: 24, z: 24 },
    { x: 0, z: 24 }, { x: 0, z: 0 },
  ]);
  paintAll(fixture.bus, fixture.graph);
  return fixture;
}

const makeRenderedGraph = renderedConnections;
```

Then update the existing degree-2 corner test:

```ts
it('uses one shared degree-2 seam with continuous paint and no overlapping caps', () => {
  const { bus, graph, scene } = renderedCorner();
  const node = [...graph.nodes.values()].find((n) => graph.edgesAtNode(n.id).length === 2)!;
  const connectionGroup = scene.getObjectByName(`road-connection-${node.id}`) as THREE.Group;
  expect(connectionGroup).toBeTruthy();
  expect(connectionGroup.children.filter((c) => c.userData.roadDetail === 'connectionSurface')).toHaveLength(1);
  expect(connectionGroup.children.filter((c) => c.userData.roadDetail === 'connectionCenterline')).toHaveLength(1);
  for (const edgeId of graph.edgesAtNode(node.id)) {
    const edgeGroup = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;
    const caps = edgeGroup.children.reduce((sum, child) =>
      sum + Number((child as THREE.Mesh).geometry?.userData.roadEndpointCaps ?? 0), 0);
    expect(caps).toBe(1); // remote degree-1 end only
  }
});

it('gives both closed-loop nodes seam geometry without controls', () => {
  const { graph, scene } = renderedPaintedLoop();
  for (const node of graph.nodes.values()) {
    const group = scene.getObjectByName(`road-connection-${node.id}`)!;
    expect(group.children.some((c) => c.userData.roadDetail === 'connectionSurface')).toBe(true);
    expect(group.children.some((c) => c.userData.roadDetail === 'junctionSurface')).toBe(false);
  }
});
```

- [ ] **Step 2: Run the continuity tests and verify RED**

Run: `npx vitest run tests/roadContinuity.test.ts`

Expected: degree-2 groups do not exist and both incident surfaces still carry endpoint caps.

- [ ] **Step 3: Generalize connection ownership in RoadRenderer**

Replace degree-3-only `junctionOwnsEdgeEnd` with:

```ts
private connectionOwnsEdgeEnd(edge: RoadEdge, nodeId: number, stage: Exclude<Stage, 'surveyed'>): boolean {
  const plan = planJunction(this.graph, nodeId);
  if (!plan || plan.kind === 'end') return false;
  const completed = junctionSurfaceStage(edge.stage);
  const requested = junctionSurfaceStage(stage);
  return completed !== null && requested !== null
    && junctionSurfaceRank(completed) >= junctionSurfaceRank(requested);
}
```

Rename the group to `road-connection-surfaces` and store one child group per node named
`road-connection-${nodeId}`. For degree 2, reuse `buildJunctionPatchGeometry` for the shared surface
and add a curved centerline connector built from the two trimmed arm endpoints plus the node center:

```ts
const stripeSamples: RoadSample[] = [
  { x: plan.x + Math.cos(a.heading) * JUNCTION_REACH, y, z: plan.z + Math.sin(a.heading) * JUNCTION_REACH, bridge: false },
  { x: plan.x, y, z: plan.z, bridge: false },
  { x: plan.x + Math.cos(b.heading) * JUNCTION_REACH, y, z: plan.z + Math.sin(b.heading) * JUNCTION_REACH, bridge: false },
];
const stripe = buildRibbonGeometry(stripeSamples, CENTERLINE_WIDTH, CENTERLINE_YLIFT, 0, Infinity);
```

Use the existing road stage colors/material tags. Add centerline only when both incident edges are
painted. Degree-3+ remains unstriped.

- [ ] **Step 4: Run continuity and renderer tests**

Run: `npx vitest run tests/roadContinuity.test.ts tests/roadRendererBands.test.ts tests/roadDetails.test.ts`

Expected: all pass; bridge tests remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/render/roadRenderer.ts tests/roadContinuity.test.ts
git commit -m "feat(render): replace degree-two cap overlap with shared seams"
```

---

### Task 4: Dirty-node caching and exact rebuild cardinality

**Files:**
- Modify: `src/render/roadRenderer.ts`
- Test: `tests/roadContinuity.test.ts`

**Interfaces:**
- Consumes: `roads:connectionsChanged`, `JunctionPlan.topologySignature`, and
  `JunctionPlan.surfaceSignature`.
- Produces: `rebuildConnections(nodeIds: readonly number[], forceControlMode?: boolean)` with signature no-op behavior.

- [ ] **Step 1: Add failing lifecycle tests**

Use geometry object identity as the observable rebuild signal; do not add test-only counters:

```ts
it('rebuilds affected connections once and ignores traffic, growth, weather, and frames', () => {
  const { bus, graph, renderer, scene } = makeRenderedGraph();
  graph.commitChain([{ x: 0, z: 0 }, { x: 32, z: 0 }]);
  graph.commitChain([{ x: 32, z: 0 }, { x: 40, z: 8 }]);
  paintAll(bus, graph);
  const node = [...graph.nodes.values()].find((n) => n.x === 32 && n.z === 0)!;
  const before = (scene.getObjectByName(`road-connection-${node.id}`)!.children[0] as THREE.Mesh).geometry;
  bus.emit('traffic:edgeEntered', { edgeId: 1, carId: 1, pos: { x: 0, y: 0, z: 0 }, firstUse: false });
  bus.emit('growth:spawn', { id: 1, kind: 'house', x: 8, z: 8, rot: 0 });
  renderer.update(1 / 60, 1);
  const after = (scene.getObjectByName(`road-connection-${node.id}`)!.children[0] as THREE.Mesh).geometry;
  expect(after).toBe(before);
});

it('rebuilds every existing incident edge after a new tie-in', () => {
  const { bus, graph, scene } = makeRenderedGraph();
  const [west] = graph.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
  const [east] = graph.commitChain([{ x: 16, z: 0 }, { x: 32, z: 0 }]);
  for (const edgeId of [west, east]) {
    graph.edges.get(edgeId)!.stage = 'painted';
    bus.emit('construction:stage', { edgeId, stage: 'painted', crew: 0 });
  }
  const oldByEdge = new Map([west, east].map((edgeId) => {
    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;
    return [edgeId, new Set(group.children.map((c) => (c as THREE.Mesh).geometry))];
  }));
  graph.commitChain([{ x: 16, z: 0 }, { x: 16, z: 24 }]);
  const junction = [...graph.nodes.values()].find((n) => n.x === 16 && n.z === 0)!;
  expect(graph.edgesAtNode(junction.id)).toHaveLength(3);
  for (const edgeId of [west, east]) {
    const group = scene.children.find((c) => c.userData.edgeId === edgeId) as THREE.Group;
    expect(group.children.every((c) => !oldByEdge.get(edgeId)!.has((c as THREE.Mesh).geometry))).toBe(true);
  }
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/roadContinuity.test.ts`

Expected: unrelated events or frames replace geometry because signature caching/transaction-only
rebuild behavior is not implemented, or the existing incident edge keeps stale endpoint geometry.

- [ ] **Step 3: Implement cached dirty-node rebuilds**

Add:

```ts
private connectionTopologySignatures = new Map<number, string>();
private connectionSurfaceSignatures = new Map<number, string>();
private connectionGroups = new Map<number, THREE.Group>();
```

Listen only to `roads:connectionsChanged` for topology recomputation:

```ts
bus.on('roads:connectionsChanged', ({ nodeIds }) => this.rebuildConnections(nodeIds));
```

For each topology event node, calculate the plan. If missing, dispose its prior group/signatures. If
`topologySignature` is unchanged, skip. Otherwise rebuild all surviving incident edge visuals first,
then replace that node's shared group and store both signatures. Remove the current unconditional
full `rebuildJunctions()` calls from `roads:edgeAdded` and
`roads:edgeRemoved`.

Construction-stage handling calls `refreshConnectionStage(nodeId)` for the edge's two endpoints;
that method compares only `surfaceSignature`, swaps material/visibility, and updates the cached
surface signature without rebuilding incident edge geometry or recalculating topology.

- [ ] **Step 4: Run focused and full tests**

Run: `npx vitest run tests/roadContinuity.test.ts tests/graph.test.ts tests/roadRendererBands.test.ts`

Then: `npm test && npm run build`

Expected: all tests/build pass; existing bundle-size advisory may remain.

- [ ] **Step 5: Update handoff and commit**

Append the event/ownership contract to `docs/HANDOFF.md`, then:

```bash
git add src/render/roadRenderer.ts tests/roadContinuity.test.ts docs/HANDOFF.md
git commit -m "perf(render): rebuild road connections only when topology changes"
```

---

### Task 5: Visual and performance verification

**Files:**
- Modify only if verification finds a defect: files owned by Tasks 1–4.

**Interfaces:**
- Consumes: completed connection cleanup system.
- Produces: verified baseline for the junction-control plan.

- [ ] **Step 1: Run a fresh-world geometry matrix**

Create straight tie-in, sharp degree-2 corner, closed loop, T-junction, 4-way junction, bridge-adjacent connection, and remove/reconnect cases. Verify no stale caps, gray cylinders, double lines, gaps, or bridge regressions.

- [ ] **Step 2: Verify cleanup cardinality at 1× and 16×**

Use a temporary local counter exposed only in browser verification, then revert it. Confirm traffic,
growth, weather, and frame updates do not change the count; one connection transaction increments
only affected nodes.

- [ ] **Step 3: Run final repository checks**

Run:

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected: full green, no temporary hooks, clean worktree after commits.

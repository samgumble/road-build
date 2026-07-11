# Roadside Realism, Completion Polish, Surface Life, and Q/E Camera Plan

> **For Claude/Codex handoff:** Execute the checked tasks in order. Keep all simulation changes deterministic and all presentation-only aging derived from stable edge ids plus live traffic events. Do not serialize renderer-only detail.

**Goal:** Add four cohesive polish upgrades—terrain/drainage integration, context-sensitive roadside furniture, construction-completion feedback, and evolving road surfaces—plus keyboard Q/E orbit controls, without changing the road graph or save format.

**Architecture:** Keep authoritative road topology and terrain in the existing sim. `RoadRenderer` owns surface-bound geometry (ditches, edge wear, patches, puddles). A new `RoadsideRenderer` owns bounded shared instanced pools for props that depend on terrain and graph context. `TrafficSim` emits edge-entry events so the render/audio layers can recognize first use and accumulate visual wear without polling cars. Camera keyboard input remains inside `CameraRig`, using held actions and frame-rate-independent integration.

**Tech stack:** TypeScript, Three.js, Vitest, Vite, existing typed `EventBus`.

---

## Task 1: Lock event and deterministic-planning contracts

**Files:**
- Modify: `src/core/events.ts`
- Modify: `src/sim/traffic/traffic.ts`
- Test: `tests/traffic.test.ts`

- [x] Add `traffic:edgeEntered` with `{ edgeId, carId, pos, firstUse }`.
- [x] In `TrafficSim`, arm newly painted live edges (`crew >= 0`), emit once on spawn/edge transition, and mark the first actual entrant.
- [x] Ensure restore-stage replay (`crew === -1`) does not trigger a false opening ceremony.
- [x] RED: test no restore false-positive, first entrant exactly once, later edge entries with `firstUse:false`.
- [x] GREEN: implement only enough state to satisfy those tests.

Core transition shape:

```ts
private enteredEdge(car: Car, lane: Lane): void {
  const edgeId = lane.edgeId;
  const firstUse = this.awaitingFirstUse.delete(edgeId);
  this.bus.emit('traffic:edgeEntered', { edgeId, carId: car.id, pos: sampleLane(lane, car.s).pos, firstUse });
}
```

## Task 2: Terrain integration and context-sensitive roadside props

**Files:**
- Create: `src/render/roadsideRenderer.ts`
- Modify: `src/render/roadRenderer.ts`
- Modify: `src/main.ts`
- Test: `tests/roadsideRenderer.test.ts`
- Test: `tests/roadDetails.test.ts`

- [x] Export pure, deterministic planners for road context (cross-slope, water proximity, curvature, junction degree, settlement proximity).
- [x] Add shallow non-bridge ditch ribbons outside both shoulders from graded onward.
- [x] Add shared instanced pools for culvert mouths, retaining-wall blocks, guardrails/posts, curve reflectors, junction signs, utility poles/crossarms, and gravel junction aprons/scatter.
- [x] Guardrails select water/drop-off sides; retaining walls select steep cross-slopes; reflectors select bends; signs select degree != 2 nodes; utility poles require nearby house/building records.
- [x] Skip bridge stations for ground props and clamp capacities without per-frame allocations.
- [x] Seed settlements after restore and maintain them from growth events.
- [x] RED/GREEN tests assert deterministic plans, context gating, bridge exclusion, and fixed draw-call pool count.

Planner contract:

```ts
export interface RoadsidePlan {
  culverts: DetailPose[];
  retainingWalls: DetailPose[];
  guardrails: DetailPose[];
  reflectors: DetailPose[];
  signs: DetailPose[];
  utilityPoles: DetailPose[];
  junctionAprons: DetailPose[];
  gravelScatter: DetailPose[];
}
```

## Task 3: Deterministic surface variation and traffic aging

**Files:**
- Modify: `src/render/roadRenderer.ts`
- Test: `tests/roadSurfaceLife.test.ts`

- [x] Add deterministic asphalt patch placements and edge-wear ribbons on painted ground ranges.
- [x] Add sparse gravel scatter at gravel/paved transitions and junction approaches through the roadside pool.
- [x] Add shallow puddle decals that fade in with the existing rain signal and are invisible when dry.
- [x] Track bounded per-edge traffic pass counts from `traffic:edgeEntered`; increase tire polish, patch contrast, and edge wear gradually with a capped pure curve.
- [x] Keep weather composition stable: rain controls roughness/puddles while traffic controls wear opacity.
- [x] RED/GREEN tests cover deterministic hash output, dry puddle invisibility, rain response, monotonic/capped wear, and bridge exclusion.

Wear curve:

```ts
export function trafficWear(passCount: number): number {
  return Math.min(1, Math.log1p(Math.max(0, passCount)) / Math.log(41));
}
```

## Task 4: Construction-completion ceremony and first use

**Files:**
- Modify: `src/audio/ambient.ts`
- Modify: `src/render/roadRenderer.ts`
- Test: `tests/roadCompletion.test.ts`

- [x] Keep the existing machinery/dressing/cone/light fade as the physical wind-down authority.
- [x] Give `painted` a restrained three-note completion swell rather than the generic stage blip.
- [x] Add a short edge-local opening sheen/pulse on `painted`.
- [x] On `traffic:edgeEntered(firstUse:true)`, play one subtle confirmation chime and briefly brighten that edge's reflectors/wear accents.
- [x] Ensure events are one-shot, no ceremony on restore, and no persistent timers/resources.
- [x] RED/GREEN tests cover the pure stage-cue profile, pulse lifecycle, and one-shot first-use path.

## Task 5: Q/E keyboard camera orbit

**Files:**
- Modify: `src/input/cameraRig.ts`
- Test: `tests/cameraRig.test.ts`

- [x] Define named held actions `rotateLeft`/`rotateRight` mapped to Q/E.
- [x] Ignore shortcuts while an input, textarea, select, or contenteditable element has focus.
- [x] Integrate yaw with `dt` in `CameraRig.update`, preserving existing mouse/touch damping and limits.
- [x] Clear held state on window blur to prevent stuck rotation.
- [x] RED/GREEN tests cover Q, E, simultaneous cancellation, text-focus guard, blur reset, and frame-rate-independent total rotation.

## Task 6: Verification, handoff, and release

**Files:**
- Modify: `docs/HANDOFF.md` (or the existing project handoff log discovered in-tree)
- Modify: this plan (check completed boxes)

- [x] Run focused tests after each slice.
- [x] Run `npm test` and `npm run build`.
- [ ] Inspect desktop and mobile layouts plus day/night/rain visuals in the live local game.
- [ ] Verify draw calls remain under 250 and no per-frame geometry/material allocation was added.
- [ ] Commit in reviewable slices, push `main`, watch GitHub Pages deployment, and verify the published build/assets.
- [ ] Record decisions, tests, commit hashes, known limitations, and next steps in the existing handoff log.

## Self-review guardrails

- Render-only ditches do not mutate the heightfield; culverts and retaining walls are visual terrain integration, not a hydrology simulation.
- All planners use stable edge/node ids and fixed sampling, never `Math.random()`.
- All shared props use bounded instancing; surface ribbons merge geometry by detail type/range.
- Traffic aging is intentionally presentation-only and may reset on reload; this avoids a save migration for cosmetic state.
- Existing bridge deck/rail ownership remains in `RoadRenderer`; roadside ground props skip bridges.
- Existing completion cleanup remains in `ConstructionRenderer`; this package layers recognition, not duplicate lifecycle state.

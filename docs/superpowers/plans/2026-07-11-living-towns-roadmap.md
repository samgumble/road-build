# Living Towns + Art Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve Groundwork from a strong road-building sandbox into a legible, characterful town-building experience with natural roads, meaningful traffic, authored construction theater, and a professional visual identity.

**Architecture:** Keep the fixed-step simulation authoritative and deterministic. Add mechanics to `src/sim/`, publish typed events through `EventBus`, and let render/UI/audio consume those events. Ship the program as six independently releasable milestones; each milestone must leave saves loadable, mobile controls intact, and the test/build/deploy pipeline green.

**Tech Stack:** TypeScript, Three.js, Vitest, Vite, glTF 2.0/GLB, GitHub Pages.

**Global Constraints:** Preserve old saves; keep sim RNG seeded; retain 44px mobile targets; keep high-tier draw calls under 250; keep low-tier free of post-processing allocation; verify at 1× and 16×; update `docs/HANDOFF.md` after every milestone.

## Release sequence

| Release | Player outcome | Primary systems | Exit gate |
|---|---|---|---|
| R1 Road Craft | Drawn roads feel deliberate and drive naturally | centerline smoothing, preview, undo | old saves load; loops/junctions exact; lane heading spikes reduced |
| R2 Living Towns | Settlements grow as readable places, not continuous walls | morphology, density pockets, setbacks, growth pacing | growth remains deterministic; road corridors stay clear |
| R3 Network Planning | Players can reason about and improve traffic | planning preview, road classes, junction policy, traffic overlay | no deadlocks in soak tests; clear UI at desktop/mobile |
| R4 Purpose & Logistics | Construction and expansion create stories | soft objectives, material trips, landmarks, milestones | objectives optional; no hard fail states |
| R5 Model & Animation Pass | Vehicles, crews, buildings, and nature feel authored | GLB pipeline, rigged workers, fleet replacements, LOD | assets fit budgets; fallback primitives remain available |
| R6 Cinematic World | Weather, lighting, water, camera, and sound feel cohesive | atmosphere, clouds, fog, IBL, water, camera stories, ambience | high/low quality both legible; real-device profiling complete |

## Task 1: Ship R1 Road Craft

Follow the detailed plan in `docs/superpowers/plans/2026-07-11-road-craft.md`.

- [ ] Smooth only derived road centerlines; retain snapped graph control points.
- [ ] Use the smoothed samples for road ribbons, lanes, terrain grading, and construction.
- [ ] Show the exact smoothed route in the draw preview.
- [ ] Add a short, explicit undo window for an unstarted survey.
- [ ] Verify loops, junction splitting, saves, lane routing, and construction progress.

## Task 2: Ship R2 Living Towns

Follow the detailed plan in `docs/superpowers/plans/2026-07-11-living-towns-experience.md`.

- [ ] Replace uniform roadside spawning with seeded settlement centers and density falloff.
- [ ] Introduce development-frontier pacing so the whole road does not urbanize at once.
- [ ] Add coherent parcel orientation, spacing, yards, and sparse civic/commercial anchors.
- [ ] Keep wilderness and agricultural buffers between settlement pockets.
- [ ] Add growth-speed presets and retain the existing growth-pause control.

## Task 3: Ship R3 Network Planning

- [ ] Add a non-authoritative planning preview showing length, grade, bridge span, estimated build time, and likely junctions before commit.
- [ ] Add `local | collector | arterial` road classes to authoritative edge state with save migration and visual/lane-speed differences.
- [ ] Add explicit intersection metadata and deterministic yield/priority behavior based on road class.
- [ ] Add an optional traffic-health overlay for speed, queue duration, and completed trips; keep it out of the default HUD.
- [ ] Invalidate and recompute routes safely when painted topology changes.
- [ ] Add seeded 30-minute grid/ring/mixed-network traffic soak tests.

## Task 4: Ship R4 Purpose & Logistics

- [ ] Add optional soft contracts: connect a settlement, create a loop, reach the quarry, relieve a jam, or open a bridge route.
- [ ] Give contracts descriptive rewards only (town renown, milestone cards, camera focus), never hard currency gates.
- [ ] Turn quarry shuttle theater into visible material deliveries keyed to construction stages without changing core build correctness.
- [ ] Add 3-5 deterministic landmark families (depot, school, farmstead, civic hall, service yard) chosen by settlement context.
- [ ] Add restrained opening-day and town-growth milestones through the existing Guide/event system.

## Task 5: Ship R5 Model & Animation Pass

Follow the detailed plan in `docs/superpowers/plans/2026-07-11-model-animation-graphics.md`.

- [ ] Establish asset manifests, scale/orientation conventions, compression, LOD, attribution, and primitive fallbacks.
- [ ] Replace the most visible construction rigs first: excavator, grader, paver, roller, dump truck.
- [ ] Add rigged worker idle/walk/signal/shovel clips and deterministic animation selection.
- [ ] Expand settlement kits and vegetation variants while retaining instancing and capacity tests.

## Task 6: Ship R6 Cinematic World

- [ ] Replace icosahedron clouds with soft layered cloud cards or low-cost volumetric impostors.
- [ ] Clamp adverse-weather fog so the road network remains playable; add camera-distance-aware fog falloff.
- [ ] Add environment lighting/IBL, contact shadows, terrain macro variation, improved water depth/shore response, and a restrained grade LUT.
- [ ] Add wind motion to vegetation and site dressing without per-instance CPU updates.
- [ ] Add camera bookmarks, focus-active-crew, and optional milestone fly-to moments with immediate player cancel.
- [ ] Complete high/low tier profiling on desktop and real mobile hardware.

## Program verification and handoff

- [ ] After each release, run focused RED/GREEN tests, then `npm test` and `npm run build`.
- [ ] Test a fresh seed and a migrated save at 1×, 4×, and 16×.
- [ ] Check desktop, 375×812 mobile, keyboard, mouse, and touch paths.
- [ ] Record commit, test count, known risks, and next release in `docs/HANDOFF.md`.
- [ ] Push only after the Git diff is reviewed and unrelated local edits remain untouched.


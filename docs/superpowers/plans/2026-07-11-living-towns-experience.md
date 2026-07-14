# Living Towns Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make world growth produce recognizable hamlets, neighborhoods, farms, and town centers while giving players clearer network-planning and traffic-improvement goals.

**Architecture:** Extend `GrowthSim` with deterministic settlement-center metadata derived from seed and painted-road access. Keep individual spawn records/save compatibility intact; density and type selection become functions of settlement influence, road class, terrain, and existing landmarks. Add optional UI overlays through typed summary events rather than renderer-to-sim polling.

**Tech Stack:** TypeScript, Vitest, Three.js instancing, existing EventBus and save migration chain.

**Global Constraints:** Same seed/input sequence remains deterministic; existing records restore unchanged; corridor clearing wins over growth; paused development still permits cleanup; traffic population remains bounded.

## Delivered foundation slice — 2026-07-11

- [x] Seeded, coordinate-derived settlement morphology creates broad development pockets and rural
  gaps without a save migration; painted degree-3 junctions raise the local density floor.
- [x] Connecting a new road to any visible sampled centerline splits the original edge into a true
  shared graph node; lane routing is covered in both directions and intersection paint is trimmed.
- [x] The engineered vegetation exclusion footprint now includes asphalt, shoulder, ditch, and a
  safety margin for both grown scenery and ambient wilderness.
- [x] Vehicle ground marks use wheel/track contact layouts; opened roads carry two wheel paths per
  direction while remaining one merged wear draw call.
- [x] Six compact source GLBs expand into 21 deterministic instanced PBR/color/silhouette variants,
  establishing a higher-quality asset library without additional network payload.

The explicit serializable `SettlementCenter`/character/objective layers below remain future work;
the delivered morphology layer is intentionally migration-free infrastructure for those systems.

## Delivered parcel-variety slice — 2026-07-13 (Claude session)

- [x] Pocket parks: a coordinate-seeded fraction of house-threshold parcels spawn `kind: 'park'`
  (field-footprint green patch + its own tree records) instead of a house — migration-free, same
  `morphologyHash` family as the pocket noise. Partial delivery of Task 2's parcel variety.
- [x] Low-rise damping: each cell rolls a seeded tolerance (1–3 buildings within 20u) when it first
  passes the upgrade gate; at/over tolerance it permanently stays a house. Breaks continuous tower
  walls without touching core upgrade rules.
- [x] Street-level town dressing shipped alongside (render-only): settlement streetlamps with
  night-gated glow in `RoadsideRenderer`, and day-strolling villagers (`villagerRenderer.ts`).

> Coordination note: the slices above are merged work — do not re-implement parks/low-rise variety
> from scratch; extend them (e.g. into `SettlementCenter` characters) instead.

## Delivered skyline-variety slice — 2026-07-14 (Claude session)

- [x] Render-only skyline shaping in `SceneryRenderer`: per-building vertical stretch via
  `skylineHeightScale` (downtown-tall within 10u of a road, damped to ~70% past 34u, deterministic
  jitter) driven by a `roadDistanceAt` probe wired from `main.ts`, plus per-instance facade tints
  through `instanceColor`. Player feedback: dense settlements read as one flat-topped tower wall.

> Coordination note: this is merged render-side work with no sim/save impact — the sim's upgrade
> rules and any future `SettlementCenter` character system remain free to reshape WHICH parcels
> become buildings; extend `skylineHeightScale`/the tint palette rather than adding a second
> per-building scale path.

## Task 1: Seed settlement pockets instead of continuous roadside walls

**Files:** `src/sim/growth/growth.ts`, `src/sim/save.ts`, `tests/growth.test.ts`, `tests/save.test.ts`

- [x] Write deterministic tests for seeded morphology, junction influence, and preserved rural gaps.
- [ ] Add serializable `SettlementCenter { id, x, z, radius, character }` records.
- [ ] Bias development rate by center influence while retaining road-distance, land, and slope gates.
- [ ] Enforce a minimum undeveloped buffer between centers.
- [ ] Migrate older saves by deriving centers from existing house/building clusters.

## Task 2: Add parcel morphology and town character

**Files:** `src/sim/growth/growth.ts`, `src/render/sceneryRenderer.ts`, `tests/growth.test.ts`, `tests/sceneryDecay.test.ts`

- [ ] Add seeded setback bands, side-yard spacing, orientation jitter, and parcel-depth limits.
- [ ] Define characters (`hamlet`, `farm`, `suburb`, `town-center`) that alter type weights and spacing, not core rules.
- [ ] Reserve sparse landmark parcels and prevent normal records from overlapping them.
- [x] Expand renderer variants without adding per-frame instance allocation.

## Task 3: Pace frontier growth and upgrades

**Files:** `src/sim/growth/growth.ts`, `src/ui/hud.ts`, `tests/growth.test.ts`

- [ ] Add a deterministic development-frontier delay from the first painted connection to each center.
- [ ] Slow early accumulation, then ease into current rates; expose Calm/Standard/Busy presets.
- [ ] Keep the existing pause toggle authoritative over positive accumulation only.
- [ ] Add Guide summaries for active centers and growth trend without per-building notifications.

## Task 4: Add optional planning and traffic insight

**Files:** `src/sim/traffic/traffic.ts`, `src/core/events.ts`, `src/ui/hud.ts`, `src/render/roadRenderer.ts`, `tests/traffic.test.ts`

- [ ] Aggregate per-edge speed, stationary time, queue length, and completed-trip counts in fixed windows.
- [ ] Publish compact snapshots and render an optional green/amber/red road overlay.
- [ ] Add a Guide diagnosis naming the two worst bottlenecks and likely cause.
- [ ] Keep the overlay disabled by default and exclude it from saves.

## Task 5: Add soft objectives and landmarks

**Files:** `src/sim/objectives.ts` (new), `src/sim/growth/landmarks.ts` (new), `src/core/events.ts`, `src/ui/hud.ts`, `src/render/sceneryRenderer.ts`, `tests/objectives.test.ts` (new)

- [ ] Generate 2-3 optional objectives from current topology and settlement state.
- [ ] Complete objectives from existing authoritative events; never poll renderer state.
- [ ] Add deterministic landmark placement and primitive/GLB render fallbacks.
- [ ] Reward completion with milestone presentation and camera focus only.

## Task 6: Verify Living Towns

- [ ] Double-run determinism tests across multiple seeds and road topologies.
- [ ] Soak 30 sim minutes with growth paused/resumed, demolition, reroading, and save/reload.
- [ ] Confirm rural gaps, center silhouettes, and traffic distribution visually at 1× and 16×.
- [ ] Run full tests/build and update `docs/HANDOFF.md`.

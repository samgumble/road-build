# Living Towns Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make world growth produce recognizable hamlets, neighborhoods, farms, and town centers while giving players clearer network-planning and traffic-improvement goals.

**Architecture:** Extend `GrowthSim` with deterministic settlement-center metadata derived from seed and painted-road access. Keep individual spawn records/save compatibility intact; density and type selection become functions of settlement influence, road class, terrain, and existing landmarks. Add optional UI overlays through typed summary events rather than renderer-to-sim polling.

**Tech Stack:** TypeScript, Vitest, Three.js instancing, existing EventBus and save migration chain.

**Global Constraints:** Same seed/input sequence remains deterministic; existing records restore unchanged; corridor clearing wins over growth; paused development still permits cleanup; traffic population remains bounded.

## Task 1: Seed settlement pockets instead of continuous roadside walls

**Files:** `src/sim/growth/growth.ts`, `src/sim/save.ts`, `tests/growth.test.ts`, `tests/save.test.ts`

- [ ] Write deterministic tests for settlement-center selection, influence falloff, and preserved rural gaps.
- [ ] Add serializable `SettlementCenter { id, x, z, radius, character }` records.
- [ ] Bias development rate by center influence while retaining road-distance, land, and slope gates.
- [ ] Enforce a minimum undeveloped buffer between centers.
- [ ] Migrate older saves by deriving centers from existing house/building clusters.

## Task 2: Add parcel morphology and town character

**Files:** `src/sim/growth/growth.ts`, `src/render/sceneryRenderer.ts`, `tests/growth.test.ts`, `tests/sceneryDecay.test.ts`

- [ ] Add seeded setback bands, side-yard spacing, orientation jitter, and parcel-depth limits.
- [ ] Define characters (`hamlet`, `farm`, `suburb`, `town-center`) that alter type weights and spacing, not core rules.
- [ ] Reserve sparse landmark parcels and prevent normal records from overlapping them.
- [ ] Expand renderer variants without adding per-frame instance allocation.

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


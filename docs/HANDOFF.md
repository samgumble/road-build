# Groundwork handoff

Groundwork is a deterministic, browser-based road-building toy. The production site is
[samgumble.github.io/road-build](https://samgumble.github.io/road-build/) and the source is
[github.com/samgumble/road-build](https://github.com/samgumble/road-build).

This is the shortest reliable starting point for a future Claude/Codex session or human
contributor. Historical implementation and review notes are intentionally retained under
`.superpowers/sdd/`, but that directory is gitignored and should be treated as supplementary
evidence rather than the project contract.

## Start here

1. Read `README.md` for controls and the player promise.
2. Read this file, then inspect the narrow subsystem you intend to change.
3. Run `npm test` and `npm run build` before editing.
4. For behavior changes, add a focused failing Vitest case first; do not weaken existing tests to
   accommodate a new behavior.
5. Keep sim code renderer-free. `src/sim/` must not import `three` or access the DOM.

## Local workflow and deployment

```sh
npm install
npm run dev       # Vite development server
npm test          # Vitest suite
npm run build     # tsc --noEmit + Vite production build
git push origin main
```

The GitHub Actions workflow at `.github/workflows/deploy.yml` publishes `main` to GitHub Pages.
After a push, verify the deployed site and a static asset (for example a music file) rather than
assuming a green build means the page is live.

## Architecture map

| Area | Entry points | Contract |
|---|---|---|
| Fixed-step runtime | `src/core/loop.ts`, `src/main.ts` | Simulation advances at `SIM_DT`; render is variable-rate. Time scale changes how many fixed steps are batched, never the step size. The pause control drops interpolation remainder and keeps rendering the frozen scene. |
| Simulation events | `src/core/events.ts` | Typed `EventBus` is the boundary between sim and render/UI/audio. Prefer a new typed event over renderer polling into sim internals. |
| Roads and construction | `src/sim/roads/`, `src/sim/construction/queue.ts` | Graph commits, split/loop behavior, construction stage train, crews, terrain grading, and demolition. `BuildQueue` exposes only compact status metrics to the UI. |
| World growth | `src/sim/growth/`, `src/sim/quarry.ts` | Deterministic road-adjacent settlement, scenery lifecycle, wilderness and quarry placement. Save/restore lives in `src/sim/save.ts`. |
| Traffic | `src/sim/traffic/traffic.ts` | Lanes, routing, junction locks, box clearing, and deterministic recovery from saturated rings. Keep changes seeded and fixed-step. |
| Rendering | `src/render/` | Three.js scene, instancing, terrain/water/sky, weather-responsive road bands, construction dressing, scenery and cars. Rendering should consume events/state; it must not become authoritative. |
| Input/UI/audio | `src/input/`, `src/ui/startScreen.ts`, `src/ui/hud.ts`, `src/audio/ambient.ts` | Generated-art title flow; draw/camera gestures; responsive event-driven HUD with per-crew aggregate progress and milestone notices; lazy gesture-started audio and optional ambient music. |

## Shipped player-facing systems

- Draw, demolish, intersections, and closed-loop roads; construction is pipelined across up to
  three crews.
- Static cones and dense night-only construction lighting (up to 24 fixed towers per crew) fade
  with a worksite; vegetation/scenery in a build corridor clears quickly and roads clamp terrain
  beneath their ribbon.
- Settlements, wilderness, quarry logistics, traffic routing, saves, mobile gestures, quality
  tiers, a two-thirds-day/one-third-night cycle, night-dimmed water, ambient music, and real photo
  capture.
- Site command UI: Draw/Demolish, speed controls, Pause/Resume (`Space`), and a live Guide
  (`H`/`?`) showing network, jobs, town, traffic, and simulation state. The guide uses a proper
  modal backdrop/focus handoff; crew lines show multi-stage job completion and concise terminal
  milestones without turning the zen toy into a notification feed.
- Rain darkens and lowers the roughness of existing road materials by surface type. Dry weather
  is an exact authored-material reset, and fresh asphalt/paint curing composes with wetness rather
  than being overwritten by it.
- Generated title presentation: `public/art/groundwork-title-dawn.jpg` plus a phone-specific crop,
  with source intent/provenance in `public/art/README.md`. `StartScreen` keeps the sim paused and
  the HUD inert until Continue/Enter/Space, then unlocks audio and crossfades into the ready world.
  New/returning sites get distinct labels without changing save semantics.

## Invariants worth protecting

- **Determinism:** Same seed and the same input sequence should reproduce sim state. Use seeded
  RNGs in sim; never wall-clock time or `Math.random()` in a simulation decision.
- **Save correctness:** Persist only authoritative state. On restore, re-derive presentation and
  graph-derived state through the existing restore path rather than inventing parallel state.
- **Terrain authority:** Road grading is the source of truth. Easement replay protects finished
  roads from later deformation; changes to heightfield batching must flush in `finally`.
- **Traffic safety:** Cars never teleport or pass through gap checks. Junction/box escape hatches
  may relax a lock or box gate, never the physical following gap.
- **Render lifetime:** Instanced scenery slot compaction must purge all animations referencing a
  freed instance. Construction dressing is pooled and must dispose cleanly.
- **Mobile UI:** Retain ≥44px touch targets, safe-area padding, and no browser-page pinch zoom.
- **Launch flow:** Start-screen art is decorative; title/actions must stay real HTML. Keep the HUD
  inert and the sim paused until dismissal, let secondary buttons receive their own Enter/Space,
  and preserve a reduced-motion path.

## Current improvement backlog

These are deliberately uncommitted product directions, not known blockers:

1. Add a short undo window for the last committed survey and clearer “cannot build here” feedback.
2. Add an optional traffic-health diagnostic (throughput/jam hot spots), not a noisy permanent HUD.
3. Introduce road classes or a planning mode before committing long networks.
4. Add camera bookmarks / focus-active-crew shortcuts for larger settlements.
5. Profile an optimized production build on a real mobile device and a built-out 16× map before
   raising visual density further.
6. Manually spot-check wet roads on a built-out save during rain. The deployed HUD and guide were
   visually checked on 2026-07-10 at desktop and 375×812 mobile sizes: no horizontal overflow,
   visible controls remained at least 44px tall, the modal stayed inside the viewport, and close
   focus/backdrop behavior was correct. Localhost automation was policy-blocked, so that check used
   the published GitHub Pages build after its workflow passed.

## Review checklist

- Scope the diff to the owning subsystem and preserve unrelated local changes.
- Verify RED → GREEN for every behavior change, then run the full suite and `npm run build`.
- Check `git status`, inspect the final diff, and confirm no temporary browser/debug hooks remain.
- If changing UI, check desktop and a narrow mobile viewport; make keyboard shortcuts ignore text
  fields and keep controls accessible.
- After deployment, verify the GitHub Pages URL rather than only the local build.

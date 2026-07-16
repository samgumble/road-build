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
- Environment-growth control: the HUD toggle persists under `groundwork-growth-paused` and calls
  `GrowthSim.setDevelopmentPaused`. It freezes only positive development accumulation, threshold
  spawns, and upgrades. Road-distance recompute, corridor clearing, stranded decay, construction,
  traffic, and weather keep advancing; do not replace it with a main-loop skip of `growth.update`.
- The site-command toolbar can collapse to a single `Show Controls` button. Its state persists under
  `groundwork-toolbar-collapsed`; keep the restore action outside `.gw-toolbar-controls` so a
  collapsed toolbar can never strand the player without a way to reopen it.
- Fields NO LONGER SPAWN (2026-07-13, per repeated player feedback: "remove grass spawning from
  the environment growth") — the 'field' threshold bit is consumed with no record. Everything
  field-shaped survives for other users of it: `placeField` places parks, field records from OLD
  SAVES still restore/render/decay, and the footprint rule below still governs both. Fields are
  10×10 squares (`FIELD_SIZE` is shared by GrowthSim and SceneryRenderer), not point records.
  Spawn clearance uses the field circumradius plus the road half-width/verge, and corridor
  clearing adds the same footprint radius. Preserve both halves of that invariant or park/field
  grass can overlap an existing/new road even while its center passes a point-distance check.
- Rain darkens and lowers the roughness of existing road materials by surface type. Dry weather
  is an exact authored-material reset, and fresh asphalt/paint curing composes with wetness rather
  than being overwritten by it.
- Road-integration visual pass: every non-survey ground stage renders a wider, lower shoulder
  ribbon under the authoritative road surface; bridge runs are subtracted so verges never float
  beside decks. Painted roads add two tire-wear strips merged into one geometry/draw call. Both
  detail types are tagged into the existing weather lifecycle and disposed through `EdgeVisual.meshes`.
  Shoulder and ditch ribbons DRAPE onto the terrain via `buildRibbonGeometry`'s `conformTo`
  parameter — per-vertex `max(road height, terrain height)` — so on a cross-slope they sit on the
  grass uphill and clamp to road height downhill instead of floating/burying. The road ribbon and
  deck never use `conformTo` (grading is the authority for the surface itself).
- Roadside-realism pass: ground roads add shallow drainage ditches; a fixed 11-pool instanced
  `RoadsideRenderer` derives culverts, retaining walls, guardrails, curve reflectors, junction
  signs/aprons, settlement utility poles, and gravel scatter from graph/terrain/growth context.
  Props are deterministic presentation state, skip bridge samples, and rebuild only on relevant
  road-stage/topology or settlement events.
- Painted surfaces now derive deterministic patches, edge wear, and rain-only puddles from stable
  edge ids. `TrafficSim` emits `traffic:edgeEntered`; `RoadRenderer` uses bounded per-edge counts to
  deepen wear while audio/road presentation recognize the first real vehicle to use a newly opened
  road. This cosmetic aging intentionally resets on reload and does not change the save schema.
- Road completion uses the construction renderer's existing machinery/cone/light wind-down, plus
  an edge-local opening sheen, a restrained completion chord, and one first-use chime. Restore
  stage replay (`crew: -1`) never arms a false ceremony.
- Q/E are held keyboard orbit actions in `CameraRig`, integrated by frame `dt`, cancelled when both
  are held, ignored while editing text, and cleared on window blur. Existing RMB/touch orbit paths
  remain unchanged.
- Generated title presentation: `public/art/groundwork-title-dawn.jpg` plus a phone-specific crop,
  with source intent/provenance in `public/art/README.md`. `StartScreen` keeps the sim paused and
  the HUD inert until Continue/Enter/Space, then unlocks audio and crossfades into the ready world.
  New/returning sites get distinct labels without changing save semantics.
- Survey feedback and undo: a rejected chain release fades AND explains itself through the notice
  channel (`explainChainRejection` in `src/sim/roads/path.ts` owns every rejection rule;
  `validateChain` is its boolean shadow — add new rules there, in one place). Each successful
  commit opens an 8-second `UNDO SURVEY` chip (`Z` shortcut) driven by the pure `UndoWindow`
  helper in `hud.ts`; undo simply routes `commitChain`'s returned edge ids (never split halves of
  crossed pre-existing roads) into `BuildQueue.enqueueDemolish`, whose existing per-state handling
  makes an untouched survey vanish instantly and a started one walk back down.
- Share: the toolbar Share button copies `islandShareUrl(location.href, seed)` — origin+path with
  exactly one `?seed=` param, any prior query/hash replaced — falling back to showing the link in
  a notice when clipboard access is denied.
- Living Towns parcel variety (partial R2, this session): a coordinate-seeded fraction of
  house-threshold parcels become pocket **parks** (`GrowthKind 'park'`: a field-footprint green
  patch record plus a couple of ordinary tree records — full decay/clearing/save lifecycle for
  free), and **low-rise damping** gives each cell a seeded tolerance (1–3) for buildings within
  20u before it permanently stays a house — towers scatter through low-rise streets instead of
  extruding walls. Both rolls use `morphologyHash` on cell coordinates + world seed (salted), so
  they consume no rng state and old saves gain them deterministically. `PARK_*`/`LOWRISE_*`
  constants in `growth.ts`; park rendering is a third field-style instanced patch in
  `sceneryRenderer.ts`.
- Streetlamps: `planRoadsideDetails` now also plans `streetlamps` — painted stations near
  settlements on the opposite side/parity to utility poles. Three more instanced pools in
  `RoadsideRenderer` (post, emissive head, additive ground-glow disc); `setNight` (driven by
  `atmosphere:phase`) gates head emissive + pool opacity, same pattern as window glow. No real
  lights — the budget stays flat.
- Villagers: `src/render/villagerRenderer.ts` — up to `VILLAGER_CAP` (12) strolling figures on
  painted verges near settlements, three shared InstancedMeshes total (legs/torso/head).
  `planVillagerRoutes` is the pure deterministic planner (one route per painted-edge × nearby
  settlement pair); phases are hash-seeded, walking uses render dt (theater ambles at any sim
  speed), and the whole group hides at night via `atmosphere:phase`. Pure render theater — no sim
  contract, no save state.
- Roadside guardrails: REMOVED ENTIRELY (2026-07-14, third player report). First the dedicated
  bridge-approach rails went; the player then still saw rails because the station loop's
  terrain-context rails (drops > 1.35u, waterside verges) plant on exactly the geometry every
  bridge approach has — an embankment beside water. The `guardrails` plan field and both instanced
  pools (bar + posts) are deleted; bridge decks keep their own rails, retaining walls and culverts
  keep covering terrain context. Regression tests pin `'guardrails' in plan === false` and the
  pool count at 11. Do not reintroduce ANY roadside guardrail without a fresh player request —
  this is the third time rails have been asked off the roads. `BRIDGE_RAIL_OFFSET` / `STAGE_YLIFT`
  stay exported from `roadRenderer.ts` (deck rails still use the former).
- Instancing audit (2026-07-13): every population-scaled renderer is instanced (cars, scenery GLB
  variants, roadside pools, construction cone/floodlight/particle pools, villagers). The only
  per-object draws are the three bounded construction crew rigs (cheap primitives per the Task 25
  ruling) and one-off landmarks. The "instanced rendering" improvement bet is closed — R5's asset
  budgets are the next lever, not more instancing.
- Lighting/atmosphere upgrade (2026-07-15, `codex/lighting-atmosphere-upgrade`): standard/physical
  materials now share a procedural PMREM environment with restrained solar-elevation intensity;
  hemisphere color shifts toward blue after sunset and ACES exposure adapts continuously instead
  of switching to a darker binary night value. Base fog begins beyond the opening overview, and
  the horizon skirt/sky dome were moved outside the maximum camera orbit and given denser geometry
  so their bands cannot become visible at wide zoom. Pure lighting curves are pinned in
  `tests/atmosphere.test.ts`; the skirt clearance contract is pinned in `tests/horizonSkirt.test.ts`.
- Settlement-density correction (2026-07-15, `codex/settlement-morphology-upgrade`): the legacy
  building threshold no longer spawns a second structure beside a parcel's house; it remains a
  consumed/save-compatible progression bit, while every new tower now comes from the existing
  in-place house upgrade path and therefore honors neighbor/low-rise gates. Skyline height now
  uses distance to the same painted degree-3 junction centers that boost growth morphology rather
  than distance to a road (all real parcels already share an 8–10u road setback, which made the
  previous falloff nearly inert). Simple-road settlements stay low-rise; connected centers peak.
- Construction-fleet grounding (2026-07-15, `codex/construction-fleet-upgrade`): every visible
  construction rig now contributes a footprint-tuned contact decal to one fixed-capacity
  `InstancedMesh`. The pool follows the renderer's eased presentation positions/headings/scales,
  clears idle slots every frame, and covers synthesized rollers, graders, and the shared crane
  without adding shadow-casting lights or per-machine draw calls. The scene contract and idle
  cleanup are pinned in `tests/constructionConvoy.test.ts`.
- Construction-model remodel (2026-07-15, `codex/construction-model-upgrade`): the original
  procedural excavator, dump truck, paver, roller, and grader fallbacks now have machine-specific
  silhouettes and semantic parts instead of slab placeholders. The excavator gains separate
  crawler tracks/bogies, glazing, counterweight, hydraulic ram, and bucket teeth; the truck gains a
  framed cab, windshield, ribbed tipping bed, and six independent wheels; the paver gains split
  hopper wings, crawler shells, operator canopy, and rear screed; the roller gains correctly
  transverse front/rear drums plus a rollover canopy; and the grader gains a cab/window shell,
  front axle, tandem frame, and circle/blade assembly. The shared wheel helper now aligns every
  axle on local Z and wheel animation rotates about that same axis. Existing dig, dump, shuttle,
  paving, rolling, grading, slope, fade, beacon, and contact-shadow behavior is unchanged. Roots
  and animated components are named for a later GLB pivot binding; the manifest/async GLB layer in
  the graphics roadmap is still future work. `tests/constructionConvoy.test.ts` pins the semantic
  part inventory, six-wheel truck layout, and transverse drum geometry.
- Terrain-material depth (2026-07-15, `codex/terrain-material-upgrade`): the terrain vertex palette
  now crossfades sand, grass, highland grass, and rock instead of snapping at fixed bands. A
  deterministic world-space value field gently varies the cliff threshold and albedo, while the
  existing `MeshStandardMaterial` shader hook adds macro roughness variation with no textures or
  extra draw calls. Deformation repaints remain deterministic; palette progression and the shader
  contract are pinned in `tests/terrainMaterial.test.ts`.
- Water-surface response (2026-07-15, `codex/water-material-upgrade`): the custom water shader now
  derives a world-space ripple normal analytically and uses a bounded rough-Fresnel term to reflect
  the live fog/sky color at glancing angles. Shore water is deliberately rougher; high/low tiers
  cap reflection strength separately. The foam band is narrower, dimmer, and less opacity-heavy,
  while the existing depth tint, night daylight multiplier, fog, and depth-based outer fade remain
  authoritative. Shader wiring and response bounds are pinned in `tests/waterMaterial.test.ts`.
- Weather legibility (2026-07-15, `codex/weather-settlement-legibility`): full rain now
  floors fog at 480–720u and retains 65% of the solar key, keeping the island road network and work
  fronts readable while roads/rain streaks still sell wet weather. High tier adds a restrained
  0.96-saturation/1.02-contrast warm grade before the existing output pass; low tier remains direct.
  Contracts live in `tests/weatherLegibility.test.ts`.
- Structure-overlap rollback (2026-07-16, `codex/connection-roadmap`): by explicit design request,
  houses/buildings may once again share or closely overlap parcel centers. Growth no longer rejects
  a structure against a reserved 9u future-tower footprint, and restored saves render every
  structure at its authoritative saved coordinates without a render-only separation pass. Focused
  contracts live in `tests/growth.test.ts` and `tests/sceneryDecay.test.ts`.
- Topology-owned road connections (2026-07-16, `codex/connection-roadmap`): each graph mutation now
  emits one sorted `roads:connectionsChanged` transaction. Degree-2 corners and closed loops own a
  shared surface, verge, and continuous painted centerline instead of overlapping edge caps;
  degree-3+ junctions retain shared conflict geometry. The pure `planJunction` policy identifies
  clear through pairs, stopped approaches, and non-conflicting signal groups. `RoadRenderer` caches
  per-node topology/surface signatures, rebuilds only affected incident edges and endpoint groups,
  disposes replaced GPU resources, and draws stop paint only on policy-stopped approaches. Contracts
  live in `tests/graph.test.ts`, `tests/junctionPlan.test.ts`, and `tests/roadContinuity.test.ts`.
- Living weather Tasks 1–4 (2026-07-16, `codex/connection-roadmap`,
  `codex/living-weather-atmosphere`, and `codex/living-weather-wind`): `WeatherController` provides a seeded five-state
  clear/overcast/rain/fog transition graph, smooth bounded snapshots, deterministic save/restore,
  cached transition durations, and a stable allocation-free snapshot object. `Atmosphere` now
  replaces its independent binary shower scheduler with that snapshot: cloud coverage/color/drift,
  bounded rain draw range/opacity, fog, sun, hemisphere fill, and exposure blend together and emit
  `atmosphere:weather` only when a transition completes. Full rain preserves the 480/720u fog and
  65% solar-key gameplay floors; coastal fog uses a denser but still navigable 380/620u floor after
  live overview QA found the plan's 35/110u floor hid the entire island. Zero-weight cloud groups
  stop submitting draw calls. The same post-update snapshot now drives road rain and water every
  frame: clear is an exact authored reset, while roughness increases ripple amplitude/speed and
  wind adds bounded shore foam before the existing daylight dimming. Trees now receive restrained,
  root-weighted GPU sway and legacy field/crop-stripe materials receive an upward-only world-phased
  ripple. These share two material uniforms, add no draw calls or per-frame matrix rewrites, and
  use Atmosphere's capped visual clock separately from sim-time scenery fades. Save persistence and
  Guide status remain Task 5 in
  `docs/superpowers/plans/2026-07-12-living-weather.md`.

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
- **No sustained synthesized tones, ever:** three separate "background drone" reports were traced
  to (1) the engine-rumble noise loop, (2) the synth pad — even after being demoted to an
  offline-only fallback — and (3) the day-shimmer sine. All are gone. Music is real tracks only;
  synthesis is reserved for one-shots and short gated pulses (plucks, blips, beeper, chatter,
  chimes). Do not add a new continuous oscillator or looping noise bed for any reason.
- **Launch flow:** Start-screen art is decorative; title/actions must stay real HTML. Keep the HUD
  inert and the sim paused until dismissal, let secondary buttons receive their own Enter/Space,
  and preserve a reduced-motion path.
- **Growth pause:** Cleanup lifecycles must remain live while positive development is paused, and
  resume must continue from the frozen accumulator with no elapsed-time catch-up.
- **Scenery footprints:** Any new scenery type larger than a point needs footprint-aware placement
  and corridor clearing; do not reuse the field/tree center-distance rule blindly.
- **Road detail layering:** Keep shoulder polygon offset weaker than the road ribbon and omit it on
  bridge arclength ranges. Decorative wear must remain presentation-only and share mesh disposal.
- **Connection ownership:** Degree-2 and degree-3+ shared surfaces belong to their graph node, while
  incident edge ribbons trim at owned ends. Rebuild connection geometry only from
  `roads:connectionsChanged` or a changed endpoint surface signature; never restore unconditional
  all-node rebuilds or retain signature entries for degree-1 endpoints.
- **Undo stays a thin input:** The undo window is wall-clock UI state, not sim state — it must
  never enter the save file, and undoing must stay "enqueueDemolish over the last commit's own
  edge ids" (filtered for edges that still exist) rather than growing a parallel removal path.

## Current improvement backlog

These are deliberately uncommitted product directions, not known blockers:

1. ~~Add a short undo window for the last committed survey and clearer “cannot build here”
   feedback.~~ Shipped — see "Survey feedback and undo" above.
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

## Latest release verification — 2026-07-16

- The `codex/connection-roadmap` release candidate passes the complete Vitest suite, `tsc --noEmit`,
  and the Vite production build. The existing bundle-size advisory remains non-blocking.
- Local production-preview smoke used a clean Broad Meadow island: two connected roads completed
  through separate crews at 16×, rendered a clean shared corner seam, emitted both Road Open
  milestones, and produced no browser console errors.
- Focused regression coverage additionally proves overlapping settlement restore coordinates,
  direct-split and tie-in invalidation cardinality, connection geometry identity/disposal, safe
  signal grouping, and deterministic mid-transition weather restore.

## Review checklist

- Scope the diff to the owning subsystem and preserve unrelated local changes.
- Verify RED → GREEN for every behavior change, then run the full suite and `npm run build`.
- Check `git status`, inspect the final diff, and confirm no temporary browser/debug hooks remain.
- If changing UI, check desktop and a narrow mobile viewport; make keyboard shortcuts ignore text
  fields and keep controls accessible.
- After deployment, verify the GitHub Pages URL rather than only the local build.

## Next program — Living Towns + Art Upgrade (planned 2026-07-11)

- Master release map: `docs/superpowers/plans/2026-07-11-living-towns-roadmap.md`.
- Road smoothing/planning/undo: `docs/superpowers/plans/2026-07-11-road-craft.md`.
- Settlement morphology, pacing, traffic insight, objectives, and landmarks:
  `docs/superpowers/plans/2026-07-11-living-towns-experience.md`.
- Model, animation, atmosphere, graphics, and camera work:
  `docs/superpowers/plans/2026-07-11-model-animation-graphics.md`.

The first Road Craft slice shipped in `3baa112`; the program plans and this handoff shipped in
`c65c603`:

- `smoothRoadCenterline` in `src/sim/roads/path.ts` applies two conservative local smoothing
  passes to short hand-drawn snap jitter, then bounded quadratic corner fillets. `RoadEdge.ctrl`
  remains snapped/topology-authoritative and saved exactly as before; only derived samples change.
- Exact edge endpoints, loop/junction nodes, preview geometry, road ribbons, construction paths,
  terrain grading, and traffic lanes all stay on one shared sample pipeline. Two-point roads retain
  the legacy sample distribution because the terrain clamp regression suite depends on it and
  they contain no intermediate wobble to improve.
- Added 3 tests: endpoint/jitter smoothing, bounded right-angle rounding, and lane steering from
  the smoothed centerline. All 33 test files pass and `npm run build` is green. The bundle-size
  advisory remains the same non-blocking warning.
- Local browser smoke check loaded an existing save through the new sampler with no console errors;
  the already-built loop network remained connected and visually smooth. No save migration is
  required.
- Road/bridge continuity is part of the same local Road Craft slice. `RoadRenderer` now folds
  full-width endpoint disks into each completed surface ribbon's existing geometry, closing the
  triangular hole between two butt-ended edge groups at degree-2 corners without adding draw
  calls. `ConstructionRenderer` lets a final active bridge span finish its descend+bounce after
  gravel progress leaves the run; the old 0.2s liveness cleanup could strand a short final span's
  mask forever at the prior 16u boundary. `tests/roadContinuity.test.ts` reproduces both failures.
- GitHub Pages run `29154017546` passed its test/build/deploy jobs. The published smoke check loaded
  `assets/index-CTYerQ0x.js` at `https://samgumble.github.io/road-build/` with no console errors.

## Living Towns / connected junctions / asset uplift — deployed 2026-07-11

Commit `c7041e6` is on `origin/main`. GitHub Pages run `29164866302` passed the full test,
production-build, artifact-upload, and deploy jobs:

- `GrowthSim` receives an independent morphology seed from `main.ts`. A pure, coordinate-derived
  two-octave field forms dense settlement pockets and quiet rural gaps; painted degree-3 junctions
  raise the nearby density floor. No save migration is required and legacy direct test callers keep
  the previous pacing when no morphology seed is supplied.
- `RoadGraph.magnetSnap` can target the sampled centerline of a two-control-point road. Committing
  there inserts a control point, replaces the original edge with two normal edges, and shares the
  resulting node with the new branch. Lane tests prove routes traverse the new T-junction both ways.
- Painted center stripes trim back 5u at degree-3+ endpoints; existing junction aprons and the
  endpoint-cap surface geometry now read as a deliberate clean intersection instead of overlapping
  dash fragments.
- `ROAD_ENGINEERED_HALF_WIDTH` is the shared asphalt + shoulder + ditch + margin footprint.
  `GrowthSim` and `WildernessSim` clear inside that whole corridor, preventing trees and field grass
  from surviving on road shoulders or drainage ditches.
- Construction dirt marks now match physical contacts: four patches for wheeled trucks/liners, two
  continuous crawler tracks for excavators/pavers, six wheel patches for graders, and two roller
  drum contacts. Painted roadway wear renders four merged strips (two wheel paths per direction).
- `SceneryRenderer` expands the six shipped source GLBs into 21 deterministic instanced variants:
  9 tree, 8 house, and 4 building looks using authored PBR material clones, grounded palettes, and
  silhouette proportion changes. This increases variety without new downloads or per-frame allocs.
- Verification: 36 Vitest files / 301 tests pass; `npm run build` passes (the existing 500kB chunk
  advisory remains non-blocking). A local 1x/16x browser smoke test loaded an established town in
  night and daylight, showed the expanded tree/building silhouettes, and produced no console errors.
- New focused coverage: graph centerline splitting, bidirectional lane routing, junction stripe
  cleanup, settlement morphology determinism/junction boost, full engineered-corridor clearing,
  vehicle contact layouts, roadway wear symmetry, and runtime model-style counts.
- The post-deploy HTTP bundle fetch was not run because the Codex session reached its usage ceiling
  immediately after Pages reported success. CI/Pages itself is green; the next worker should make
  one direct published-site smoke check before starting another release slice.

## Topology-owned junctions and bridge approaches — local 2026-07-11

- `RoadRenderer` now owns degree-3+ intersections with one convex, topology-derived polygon built
  from incident road headings. Completed asphalt, gravel, earth, shoulder, ditch, wear, paint, and
  opening-pulse geometry terminates 5u before the node; the shared junction mesh owns the conflict
  area and follows the same construction-stage and rain-material lifecycle as ordinary roads.
- The old `RoadsideRenderer` gray cylinder apron was removed. Do not reintroduce presentation-only
  intersection disks or independently overlaid edge strips at connected junctions.
- Ground-to-bridge transitions use explicit 6u variable-width approach meshes. Ordinary road
  surfaces, shoulders, ditches, repair patches, puddles, and edge wear are partitioned around those
  zones, so the taper is the sole surface owner rather than a coplanar overlay. Fully-overwater
  bridges remain unchanged.
- Regression coverage in `tests/roadContinuity.test.ts` verifies the junction ownership radius,
  endpoint-cap removal, exact approach extents/widths, and non-overlapping surface/detail ranges.
  `tests/roadsideRenderer.test.ts` proves the legacy apron pool is gone.
- Verification: 36 Vitest files / 304 tests pass; `npm run build` passes with only the existing
  bundle-size advisory. A local saved-world smoke check showed clean connected intersections and
  no browser warnings/errors.
- Junction alignment + deep-clean rework (2026-07-13, Claude session, player feedback "out of
  alignment / not cleaned up enough"):
  - `buildJunctionPatchGeometry` now takes `JunctionArm[]` (node tangent/height + the arm's ACTUAL
    cross-section at the 5u trim reach, walked along real samples by `edgeArmAtNode`). Hull
    vertices carry per-arm heights, so the patch drapes across sloped junctions and its corners
    meet each trimmed ribbon end exactly even when arms curve inside the reach — no more flat
    max-height plane floating over downhill arms.
  - A shoulder-width `junctionVerge` apron (lowest present stage's shoulder color) is drawn under
    every junction patch so arm shoulder stubs blend instead of ending raw on terrain.
  - Drainage ditches trim back 9u (surface trim 5u + `DITCH_JUNCTION_SETBACK` 4u) at junction-owned
    ends so ditch strips never point into the apron.
  - Angle-aware verge clearance (2026-07-14, player: "ditches and sides of road must never overlap
    the actual road on intersections"): the fixed trims above only clear ~90-degree crossings — at
    acute arm angles (and sharp degree-2 corners, which ownership trims never touched) a 4.35-5u
    half-width strip still lay across the neighbor's 6u road. `vergeJunctionSetback(ownHeading,
    otherHeadings, stripHalf)` (exported, `roadRenderer.ts`) grows each strip's end setback as
    `(roadClear + stripHalf*cos(phi)) / sin(phi)`, clamped at 22u, skipping arms past 135 degrees;
    it applies per strip width at ANY node with 2+ edges. Regression: a 45-degree Y-junction where
    no shoulder/ditch vertex may come within ROAD_WIDTH/2 of another edge's samples.
  - `planRoadsideDetails` keeps cosmetic props (gravel, reflectors, poles, lamps, culverts) at
    least 10u (`JUNCTION_PROP_CLEARANCE`) from degree-3+ nodes; safety rails/walls and the
    junction sign are unaffected.
  - Coverage: sloped-junction patch heights, curved-arm corner anchoring, ditch setback, apron
    presence/size, road-anchored approach-rail poses, and junction prop exclusion (6 new tests in
    `roadContinuity.test.ts` / `roadsideRenderer.test.ts`).
- Visual polish pass (2026-07-14, player request "make it look prettier/more polished"):
  - Junction paint: painted degree-3+ arms get a stop line (JUNCTION_REACH + 0.4) and a 6-bar
    zebra crosswalk (reach + 1.6), positioned from each arm's real cross-section so they follow
    curves/slopes; one merged mesh per junction, `roadDetail: 'junctionPaint'`.
  - Window grids: houses plant 1-2 window quads, buildings a 3-6 row grid scaled by their
    skyline-stretched height (front/side faces, jitter, occasional dark flat) — `Instance.windowSlots`
    is now an ARRAY; compaction frees slots in descending order and retargets the moved owner's
    entry (see freeSlot). WINDOW_CAPACITY covers the worst case in one draw call.
  - Horizon skirt (`src/render/horizonSkirt.ts`, DOM-safe module): an inward-facing cylinder just
    inside the fog's far distance with a vertical alpha fade — the island edge dissolves into haze
    instead of ending like a table edge. Fog does the tinting; no per-frame sync.
  - Soft clouds (graphics-plan Task 4 slice, claimed in that doc): merged soft cards with a radial
    alpha falloff replace the hard icosahedron puffs; Lambert-lit so they dim at night; identical
    rng consumption/positions/drift.
  - Per-instance weathering tints on traffic cones and survey stakes via instanceColor.
  - (Car headlights were already shipped upstream — checked before implementing.)
- Construction theater one-shots (2026-07-14): a low settle THUNK when a bridge deck span lands
  (`construction:deckSettled` event, emitted by `constructionRenderer.settleBridgeSpan` with the
  span's world x for panning) and a soft crack-rustle per corridor tree felled by the grading
  front (`wilderness:cleared` batches + `growth:cleared` with the new optional `kind` payload —
  only `kind: 'tree'` rustles). Rustles are rate-limited (>= 90ms apart, queue capped at 8 so 16x
  clears don't machine-gun). Both are strictly self-contained one-shots per the invariant below.
- Junction cleanup, third pass (2026-07-14, "10x the junction cleanup"):
  - The verge apron's arms extend to each arm's ACTUAL angle-aware shoulder start (not the fixed
    5u reach), so acute junctions get a continuous verge wedge instead of bare gaps.
  - Painted-on details are clamped by their own lateral extent via `vergeSetbacksFor`: tire wear
    (~2.1u), surface-life patches/puddles/edge wear (half road), and centerline dashes — nothing
    painted on one road can cross onto a neighboring arm's asphalt.
  - `planRoadsideDetails` ends with a corridor guard: every planned pose (all pools) within
    ROAD_WIDTH/2 + 0.3 of any developed edge's sample is dropped; the junction sign instead picks
    the first side of the node that stands clear.
- Progressive corridor clearing (2026-07-14, player request "trees removed during the step after
  surveying"): both `WildernessSim` and `GrowthSim` now ALSO listen to `construction:progress`
  (stage `'graded'`, non-demolish) and sweep their corridor up to the front's arclength `t` — trees
  and grown records fall AS the excavator passes them, not all at once when grading completes.
  `clearCorridor(edgeId, upTo)` tracks a per-edge `sweptTo` arclength so each stretch is scanned
  exactly once; the original `construction:stage >= graded` listener remains as the tail sweep and
  the restore path (restored edges replay no progress events). Demolition progress never clears.
- Calm lighting at fast-forward (2026-07-14): the day/night cycle caps at
  `ATMOSPHERE_MAX_TIMESCALE` (4x, exported with `atmosphereTimeScale` from `solarTime.ts` — NOT
  atmosphere.ts, so tests can import it without DOM-touching sky/quality modules). At 16x the sim,
  crews, traffic, and growth still run full speed; only the lighting stops strobing noon->midnight
  every couple of minutes.
- Skyline variety (2026-07-14, player feedback "dense settlements read as a uniform wall"):
  buildings get a per-instance vertical stretch from `skylineHeightScale(roadDistance, jitter)` —
  full downtown height inside 10u of a road, damped to ~70% past 34u, times deterministic
  per-tower jitter — plus a subtle per-instance facade tint via `InstancedMesh.instanceColor` (no
  extra draw calls). `main.ts` wires a `roadDistanceAt` probe (nearest road sample; called once
  per building spawn); without the probe (tests/tools) buildings vary by jitter alone. The
  stretch persists through pop-in/fade/recover transforms and slot compaction (which now also
  moves `instanceColor`); window quads sit at the scaled height. Restore replays placement, so
  existing saves pick the variety up on load. Test hooks: `verticalStretchOf(id)` /
  `facadeTintOf(id)`; coverage in `tests/skylineVariety.test.ts`. NOTE for test authors: a second
  SceneryRenderer in one test process never resolves its GLTF load (three.js FileLoader in-flight
  dedup) — share one instance per file, like sceneryDecay.test.ts.
- Crane deck-segment orientation fix (2026-07-14): the lowered slab's scale axes were swapped —
  `rotation.y = -spanHeading` maps local +X onto the road direction, but the 16u span length was
  applied to Z (across the road) and the 5.4u width to X, so every dropped segment appeared ~3x
  too wide. The mesh is named `crane-deck-segment` for test reach; `roadContinuity.test.ts` locks
  the along-road length vs across-road width mid-descend.

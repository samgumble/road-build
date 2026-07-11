# Road Craft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make hand-drawn roads render and drive like plausible roads by suppressing grid wobble, rounding meaningful bends, preserving exact topology, and giving players a safe preview/undo workflow.

**Architecture:** `RoadEdge.ctrl` remains the snapped, saved, topology-authoritative polyline. `makeSampler()` derives a smoothed centerline used by road rendering, terrain grading, construction progress, and lane generation. DrawTool already previews `makeSampler()`, so preview and committed geometry remain identical. Undo is an additive graph/queue operation allowed only before physical work starts.

**Tech Stack:** TypeScript, Three.js, Vitest.

**Global Constraints:** No save migration for smoothing; endpoints and split points must remain exact; no Catmull-Rom overshoot; loops must still produce two normal edges; smoothing must be deterministic and allocation-bounded.

## Task 1: Add topology-safe centerline smoothing

**Files:**
- Modify: `src/sim/roads/path.ts`
- Test: `tests/path.test.ts`
- Test: `tests/lanes.test.ts`

- [ ] Write failing tests proving short snapped zigzags shrink, exact endpoints remain unchanged, and a 90-degree corner stays inside its adjacent-segment envelope.
- [ ] Export `smoothRoadCenterline(ctrl: P2[]): P2[]`.
- [ ] Apply two conservative local smoothing passes only where both adjacent control legs are short.
- [ ] Round retained bends with bounded quadratic fillets sampled near 2u spacing.
- [ ] Replace the uniform Catmull-Rom flattening inside `makeSampler()` with the new centerline.
- [ ] Add a lane regression asserting the derived lane has bounded adjacent heading change and exact graph connectivity.
- [ ] Run `npx vitest run tests/path.test.ts tests/graph.test.ts tests/lanes.test.ts`.
- [ ] Commit: `feat(roads): smooth drawn centerlines for rendering and traffic`.

## Task 2: Protect loops, intersections, restore, and terrain behavior

**Files:**
- Modify: `tests/graph.test.ts`
- Modify: `tests/save.test.ts`
- Modify: `tests/roadTerrainClamp.test.ts`

- [ ] Add a closed-loop test that checks both half-edge sample endpoints equal their shared node coordinates.
- [ ] Add a junction-split test proving each replacement edge terminates exactly at the split control point.
- [ ] Add save/restore equality for smoothed samples generated from the same controls.
- [ ] Add a curved-road ribbon/clamp scan using the existing road-terrain epsilon.
- [ ] Run the four focused suites and then the full test suite.
- [ ] Commit: `test(roads): protect smoothed topology and terrain invariants`.

## Task 2A: Guarantee road and bridge surface continuity

**Files:**
- Modify: `src/render/roadRenderer.ts`
- Modify: `src/render/constructionRenderer.ts`
- Test: `tests/roadContinuity.test.ts`

- [ ] Reproduce the short-final-span bridge bug: a 20u run splits into a 16u span plus a 4u
  remainder, whose 1.85s settle outlives the 0.2s progress-liveness timeout.
- [ ] Keep an active final bridge span alive until settle completes; still clean immediately if
  the owning edge disappears; clear the deck mask on the next idle frame.
- [ ] Reproduce the degree-2 corner hole caused by two independently butt-ended edge ribbons.
- [ ] Add full-width endpoint disks directly to the authoritative ribbon geometry (no additional
  mesh or draw call), only when a stage range reaches a true edge endpoint.
- [ ] Verify partial stage fronts do not receive a cap, bridge masking remains authoritative, and
  weather/material tagging remains on the combined ribbon mesh.
- [ ] Run `npx vitest run tests/roadContinuity.test.ts tests/roadRendererBands.test.ts tests/railGeometry.test.ts`.
- [ ] Commit: `fix(render): guarantee continuous road joins and final bridge spans`.

## Task 3: Add planning metrics to the existing preview

**Files:**
- Modify: `src/input/drawTool.ts`
- Modify: `src/ui/hud.ts`
- Modify: `src/core/events.ts`
- Test: `tests/drawTool.test.ts`
- Test: `tests/hud.test.ts`

- [ ] Add a pure `measureRoadPlan(samples, hf)` returning length, maximum grade, bridge length, and estimated build duration.
- [ ] Emit `road:previewChanged` only when the snapped chain changes; emit `null` on cancel/commit.
- [ ] Render one compact HUD line near the draw controls; hide it outside Draw mode.
- [ ] Color only invalid/excessive-grade warnings; keep normal metrics quiet.
- [ ] Verify mobile wrapping and that pointer movement within the same snap does not spam events.
- [ ] Commit: `feat(ui): show road length grade and bridge preview`.

## Task 4: Add a safe survey undo window

**Files:**
- Modify: `src/sim/construction/queue.ts`
- Modify: `src/sim/roads/graph.ts`
- Modify: `src/ui/hud.ts`
- Modify: `src/core/events.ts`
- Test: `tests/queue.test.ts`
- Test: `tests/hud.test.ts`

- [ ] Add `BuildQueue.cancelUnstarted(edgeId): boolean`, permitted only while the edge is queued or still at zero survey progress.
- [ ] Remove the edge through the normal graph lifecycle so lane/growth/render listeners stay coherent.
- [ ] Expose an Undo button for the latest eligible edge for 8 real seconds; support Ctrl/Cmd+Z when focus is not in a text field.
- [ ] Disable undo as soon as survey progress becomes non-zero and explain why via accessible button text.
- [ ] Test queue removal, active-survey rejection, loop-half behavior, and keyboard focus guards.
- [ ] Commit: `feat(roads): undo newly surveyed roads before work starts`.

## Task 5: Verify and release Road Craft

- [ ] Run `npm test` and `npm run build`.
- [ ] Draw straight, S-curve, sharp corner, junction, bridge, and closed-loop roads on a fresh seed.
- [ ] Verify road ribbon, graders, cones/lights, and cars follow the same centerline.
- [ ] Load an old save and confirm roads improve without topology changes.
- [ ] Check mouse, touch draw, Q/E camera rotation, and 375×812 HUD layout.
- [ ] Update `docs/HANDOFF.md` with constants, tests, commit, and residual tuning notes.

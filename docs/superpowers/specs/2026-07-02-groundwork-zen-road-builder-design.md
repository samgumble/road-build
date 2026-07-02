# Groundwork — Zen Civil Construction Road Builder (Design Spec)

**Date:** 2026-07-02
**Status:** Approved by user
**Working title:** Groundwork (changeable)

## 1. Concept

A meditative, polished 3D road-building toy for the web. The player sketches roads
across a procedurally generated low-poly island; animated civil construction crews
build them stage by stage; ambient traffic drives the network; scenery and settlement
grow organically alongside the roads; a slow day/night cycle and generative ambient
audio carry the atmosphere.

**No failure states, no timers, no score.** The reward is watching the world get built
and come alive.

### Core loop

1. **Sketch** — drag on terrain to draw a road. Control points snap to a coarse grid;
   smooth Catmull-Rom curves form between them. A dashed survey line with stakes
   previews the route. Invalid routes (too steep, off-island) are gently tinted red and
   clamped — never an error dialog.
2. **Watch it get built** — a crew works the segment through stages:
   *surveyed → graded → gravel → paved → painted*. An excavator grades (terrain
   visibly deforms), a dump truck delivers gravel, a paver lays asphalt, a roller
   compacts, a line truck paints stripes. Water/valley crossings get bridges: pylons
   rise, spans assemble one by one.
3. **The world responds** — cars drive the finished network; trees, fields, houses,
   and small buildings sprout near roads over time; traffic scales with settlement.
4. **Ambience** — day/night cycle (sunset light, headlights, lit windows), drifting
   cloud shadows, occasional rain, generative ambient soundtrack with positional
   construction/traffic/nature sounds.

Player can also **demolish** (crew removes the road in reverse stages) and
**regenerate** a new island from a seed.

## 2. Key decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Genre | Zen/creative builder toy | Polish and feel are the priority |
| Theme | Civil construction — crews visibly build what you draw | User direction |
| Rendering | 3D low-poly stylized, Three.js | Most impressive; Three.js skills available |
| Road model | **Snapped splines**: freeform drawing, control points snap to coarse grid, intersections only at snap nodes | Organic look with tractable intersection topology and lane-graph derivation |
| Platform | Desktop-first, mouse input | Simplest path to polished feel; touch is v2 |
| Hosting | GitHub Pages via Actions | Free, push-to-deploy static hosting |
| Backend | None; saves in localStorage | Pure static site |

## 3. Tech stack

- **Vite + TypeScript + Three.js.** No UI framework; plain DOM for the minimal HUD.
- **Vitest** for unit tests of renderer-free sim logic.
- **GitHub Actions** workflow: build on push to `main`, deploy to GitHub Pages.

## 4. Architecture

Modules communicate through an event bus, not direct references. Sim logic is
renderer-free and deterministic from a seed.

**Data flow:** input mutates the road graph → construction queue reacts → completed
segments update the lane network → traffic and scenery react to the network.

### Modules

- **`core/`** — game loop (fixed-timestep simulation, interpolated rendering), event
  bus, seeded RNG, versioned save/load (localStorage JSON, graceful fallback to fresh
  world on corrupt/old saves).
- **`terrain/`** — simplex-noise heightmap on a coarse grid; water level; finite
  island (natural framing + performance cap); mesh with vertex colors by
  height/slope (sand/grass/rock). API: `heightAt(x, z)`, `deform(path)` for road
  grading. Terrain chunked for partial re-mesh on deform.
- **`roads/`** — the heart. Graph of **nodes** (snap points) and **edges**
  (Catmull-Rom curves). Derives: extruded road mesh (asphalt, shoulders, center
  line), bridge segments where the curve leaves ground/crosses water, and the
  **lane network** (right-hand offset path per direction plus junction connectors)
  that traffic drives. Drawing over an existing edge splits it at a new node.
- **`construction/`** — build queue + per-segment stage state machine
  (*surveyed → graded → gravel → paved → painted*). Construction vehicles
  (excavator, dump truck, paver, roller, line truck) are kinematic actors that
  traverse the segment and advance its stage; the road mesh swaps
  geometry/material per stage; terrain deformation occurs during grading.
  Demolition runs stages in reverse.
- **`traffic/`** — ambient cars spawn at houses/map edges, A* over the lane graph
  to destinations, path-following with curve-based speed control, spacing behind
  slower cars, and turn-taking at junctions (no physical collision resolution).
  Car count scales with settlement size.
- **`scenery/`** — growth sim on the terrain grid: cells near finished roads
  accumulate development; thresholds spawn trees → fields → houses → small
  buildings. Poisson-disc placement, soft pop-in animation, instanced meshes.
- **`atmosphere/`** — day/night cycle (sun position, color grading, street/house/
  headlights at night), drifting cloud shadows, occasional rain, distance fog.
  Lighting plus a few custom shaders.
- **`audio/`** — Web Audio generative ambient: pad layers shifting with time of
  day; positional one-shots and loops (engines, backup beeps, birds). Fully
  synthesized — no licensed assets.
- **`input/` / `ui/`** — smooth-damped orbit/pan/zoom camera; draw tool; demolish
  tool; time-speed control; seed/new-world; screenshot button. Minimal HUD.

## 5. Polish requirements (first-class, not afterthoughts)

- All state changes eased/tweened: no popping — roads, terrain deform, scenery
  growth, UI transitions.
- Tactile drawing: magnetic snap feel, stakes plant with dust puffs.
- Construction showpiece effects: excavator dust, asphalt steam, wet-asphalt sheen
  that dries, roller compaction trail, vehicle beacon lights and headlights.
- Camera: smooth damping everywhere; idle "cinematic mode" slow drift; gentle
  FOV/exposure shifts at dawn/dusk.
- Performance: instanced rendering (scenery, cars), terrain chunking, capped island
  size. Target 60 fps on a typical desktop.

## 6. Testing

- **Vitest unit tests** for renderer-free logic: road graph ops (snapping, edge
  splitting, lane-graph derivation), construction state machine, traffic
  pathfinding/spacing, growth sim, save/load round-trip, seeded determinism.
- **Visual verification** via local dev server and browser screenshots during
  development.
- WebGL-unsupported browsers get a friendly static fallback message.

## 7. Deployment

GitHub repo → Actions workflow → Vite build → GitHub Pages at
`https://<username>.github.io/<repo>/`. Vite `base` configured for project pages.

## 8. Out of scope (v1)

Touch/mobile input, tunnels, multiple road types (highways/dirt-road upgrades),
pedestrians, multiplayer, audio asset files. Candidates for v2.

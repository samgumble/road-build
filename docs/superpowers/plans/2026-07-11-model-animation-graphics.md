# Model, Animation, and Graphics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the most visible placeholder geometry, add readable motion and environmental life, and improve atmosphere without sacrificing Groundwork's clean diorama style or mobile performance.

**Architecture:** Introduce a manifest-driven GLB layer with strict transform/material/LOD conventions and primitive fallbacks. Simulation continues emitting semantic state; renderers translate state into animation clips and effects. High-tier gains optional effects, while low-tier retains the same art direction with reduced density and no composer allocation.

**Tech Stack:** Three.js GLTFLoader/AnimationMixer, glTF 2.0/GLB, Meshopt/Draco where justified, KTX2 later, existing quality tiers and instancing.

**Global Constraints:** CC0/original assets only with provenance; construction vehicle target ≤250KB compressed each; worker target ≤150KB; static prop target ≤100KB; no more than 2 materials per vehicle; no per-frame loader/allocation; graceful fallback on asset failure.

## Task 1: Establish the asset foundation

**Files:** `src/render/assets.ts`, `src/render/modelManifest.ts` (new), `public/models/README.md`, `tests/modelManifest.test.ts` (new)

- [ ] Define canonical +X forward, +Y up, meters/world-unit scale, origin-at-ground-contact conventions.
- [ ] Add typed manifests for URL, scale, rotation, material policy, LOD, attribution, and fallback builder.
- [ ] Cache GLBs and cloned skeletons; expose load status and reject malformed entries in tests.
- [ ] Add a command/documented workflow for compression and triangle/material reporting.

## Task 2: Replace the construction fleet

**Files:** `src/render/constructionRenderer.ts`, `src/render/modelManifest.ts`, `public/models/construction/*`, `tests/constructionConvoy.test.ts`

- [ ] Replace excavator, grader, paver, roller, and dump truck in that order.
- [ ] Preserve existing per-kind groups, target transforms, fades, shuttle ownership, lights, and disposal.
- [ ] Map procedural states to named pivots/clips: tracks/wheels, boom, bucket, blade, hopper, roller drum.
- [ ] Keep primitive rigs as asynchronous-loading and low-memory fallback.

## Task 3: Add workers and settlement kits

**Files:** `src/render/constructionRenderer.ts`, `src/render/sceneryRenderer.ts`, `public/models/workers/*`, `public/models/scenery/*`, `tests/sceneryDecay.test.ts`

- [ ] Add one rigged worker with idle, walk, signal, shovel, and break clips; recolor PPE by crew.
- [ ] Expand houses/buildings to at least 6/4 silhouettes with shared material atlases.
- [ ] Add fences, sheds, signs, and yard props via deterministic instancing.
- [ ] Keep upgrade/remove/recovery slot-compaction tests green.

## Task 4: Add environmental motion

**Files:** `src/render/sceneryRenderer.ts`, `src/render/sky.ts`, `src/render/atmosphere.ts`, `tests/atmosphere.test.ts`

- [ ] Add vertex-shader wind to trees/grass using world position and weather strength.
- [ ] Replace hard polyhedron clouds with layered soft cards/impostors and deterministic drift.
- [ ] Add subtle birds/insects near appropriate biomes with shared bounded pools.
- [ ] Respect reduced motion and low-tier density.

## Task 5: Improve lighting, terrain, water, and grading

**Files:** `src/render/scene.ts`, `src/render/postfx.ts`, `src/render/terrainRenderer.ts`, `src/render/atmosphere.ts`, `src/render/quality.ts`

- [ ] Add a small environment map or procedural sky contribution for coherent reflections.
- [ ] Add contact-shadow decals or a low-cost blob-shadow pool beneath vehicles/large props.
- [ ] Introduce terrain macro color/roughness variation and slope-aware rock seasoning.
- [ ] Improve water depth color, shoreline foam restraint, night response, and reflection roughness.
- [ ] Clamp rain/fog to a gameplay-legibility floor and add a restrained LUT/grade on high tier.
- [ ] Gate SSAO/contact AO behind measured ≥55fps headroom only.

## Task 6: Add camera storytelling

**Files:** `src/input/cameraRig.ts`, `src/ui/hud.ts`, `src/core/events.ts`, `tests/cameraRig.test.ts`

- [ ] Add 3 user bookmarks and focus-active-crew/focus-milestone actions.
- [ ] Add optional short eased fly-to shots that cancel instantly on any camera input.
- [ ] Keep Q/E, RMB, middle-pan, pinch, twist, and touch draw cancellation behavior unchanged.

## Task 7: Profile and release

- [ ] Record triangles, draw calls, texture memory, load bytes, and frame times for fresh and built-out worlds.
- [ ] Test high/low tiers on desktop and a physical mobile device.
- [ ] Test asset-load failure and confirm primitive fallbacks produce a playable scene.
- [ ] Run full tests/build, update asset provenance, and update `docs/HANDOFF.md`.


# Groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build "Groundwork" — a zen 3D civil-construction road-building web toy where sketched roads are visibly built by animated crews on a procedural island that grows alive around them.

**Architecture:** Renderer-free deterministic simulation modules (`src/sim/`, `src/core/`) communicate with Three.js rendering modules (`src/render/`) exclusively through a typed event bus. Input mutates the road graph → construction queue builds edges through stages → painted edges produce a lane network → traffic and scenery growth react. Fixed-timestep sim, interpolated render.

**Tech Stack:** Vite, TypeScript (strict), Three.js, simplex-noise, Vitest, Web Audio API, GitHub Pages via GitHub Actions.

## Global Constraints

- All sim code (`src/core/`, `src/sim/`) imports **nothing from `three`** — it must run under Vitest in Node.
- Determinism: identical seed ⇒ identical heightfield, growth, and RNG streams.
- TypeScript `strict: true`. No `any` except where a comment justifies it.
- Assets ARE permitted where they improve the experience (user directive 2026-07-02, supersedes the spec's no-assets rule): CC0-licensed (e.g., Kenney packs) or self-generated only; keep the deployed payload lean (prefer <10 MB total); every asset-loading path needs a graceful procedural fallback. Where assets add nothing, stay procedural.
- World constants (exact values, defined once in `src/core/constants.ts`):
  `WORLD_SIZE = 512`, `GRID_SIZE = 129`, `CELL = 4`, `SNAP = 8`, `WATER_LEVEL = 0`, `ROAD_WIDTH = 6`, `LANE_OFFSET = 1.5`, `MAX_ROAD_GRADE = 0.35`, `SIM_DT = 1/60`, `DAY_LENGTH = 240` (seconds per full day).
- Coordinate system: X/Z horizontal, Y up. Cars drive on the right.
- Construction stages, in order: `surveyed → graded → gravel → paved → painted`. Demolition runs them in reverse.
- Target 60 fps on a typical desktop GPU: instanced meshes for trees/houses/cars, terrain re-meshed only in dirty regions.
- No failure states in gameplay; invalid input is prevented/clamped, never error-dialogued.
- UI aesthetic (deliberate, theme-tied — not framework defaults): "engineer's site plan" — charcoal `#1d1f21` panels, thin 1px rules, uppercase letter-spaced labels in a system mono stack (`ui-monospace, 'SF Mono', Menlo, monospace`), safety-orange `#e8641b` accent, no border radii above 3px, no drop shadows, no gradients.
- Commit after every task (at minimum). Conventional commit messages.

---

## File Structure

```
/ (repo root)
├── index.html                     — entry, HUD DOM skeleton, WebGL fallback message
├── package.json / tsconfig.json / vite.config.ts / vitest.config.ts
├── .github/workflows/deploy.yml   — build + GitHub Pages deploy
├── src/
│   ├── main.ts                    — wiring: construct sim + render + input + UI, start loop
│   ├── core/
│   │   ├── constants.ts           — world constants (above)
│   │   ├── types.ts               — V3, P2, Stage, VehicleKind, shared interfaces
│   │   ├── rng.ts                 — createRng(seed) seeded PRNG
│   │   ├── events.ts              — EventBus + GameEvents map
│   │   └── loop.ts                — fixed-timestep Loop with timeScale
│   ├── sim/
│   │   ├── terrain/heightfield.ts — noise island, heightAt, isLand, flattenCircle
│   │   ├── roads/path.ts          — Catmull-Rom sampling, elevation smoothing, bridge flags, validateChain
│   │   ├── roads/graph.ts         — RoadGraph: nodes/edges, snapping, commitChain, splitEdge
│   │   ├── roads/lanes.ts         — buildLaneGraph, Lane, findRoute (A*)
│   │   ├── construction/queue.ts  — BuildQueue: per-edge stage FSM, vehicle progress, demolition
│   │   ├── traffic/traffic.ts     — TrafficSim: cars, spacing, junction locks
│   │   ├── growth/growth.ts       — GrowthSim: development field, spawn thresholds
│   │   └── save.ts                — serialize/deserialize world (versioned)
│   ├── render/
│   │   ├── scene.ts               — renderer, scene, lights, resize
│   │   ├── terrainRenderer.ts     — terrain mesh + vertex colors + water plane, partial updates
│   │   ├── roadRenderer.ts        — per-edge road ribbons by stage, bridges, survey preview
│   │   ├── constructionRenderer.ts— crew vehicle meshes following progress events, dust/steam
│   │   ├── carRenderer.ts         — instanced ambient cars
│   │   ├── sceneryRenderer.ts     — instanced trees/fields/houses/buildings with pop-in
│   │   ├── atmosphere.ts          — day/night, sky/fog colors, clouds, rain
│   │   └── easing.ts              — easeOutCubic, easeOutBack, smoothstep helpers
│   ├── input/
│   │   ├── cameraRig.ts           — damped orbit/pan/zoom + idle cinematic drift
│   │   └── drawTool.ts            — raycast → snapped chain, survey preview, commit/demolish
│   ├── audio/ambient.ts           — generative pads, birds/crickets, construction sfx
│   └── ui/hud.ts                  — toolbar, time speed, new world, screenshot, autosave
└── tests/
    ├── rng.test.ts, events.test.ts, loop.test.ts
    ├── heightfield.test.ts
    ├── path.test.ts, graph.test.ts, lanes.test.ts
    ├── queue.test.ts, traffic.test.ts, growth.test.ts
    └── save.test.ts
```

Dependency direction: `render/`, `input/`, `ui/`, `audio/` depend on `sim/` + `core/`; never the reverse.

---

### Task 1: Project scaffold + deploy pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `.github/workflows/deploy.yml`, `.gitignore`

**Interfaces:**
- Produces: `npm run dev` (Vite dev server), `npm test` (Vitest), `npm run build` (static `dist/`). `index.html` exposes `<canvas id="app">` and `<div id="hud">`.

- [ ] **Step 1: Scaffold files**

`package.json`:
```json
{
  "name": "groundwork",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "simplex-noise": "^4.0.3",
    "three": "^0.166.0"
  },
  "devDependencies": {
    "@types/three": "^0.166.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "types": ["vite/client"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "tests"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
export default defineConfig({ base: './' });
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Groundwork</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #1d1f21; }
    #app { display: block; width: 100%; height: 100%; }
    #hud { position: fixed; inset: 0; pointer-events: none;
           font-family: ui-monospace, 'SF Mono', Menlo, monospace; color: #d8d5cd; }
    #nogl { display: none; position: fixed; inset: 0; place-items: center;
            color: #d8d5cd; font-family: ui-monospace, Menlo, monospace; }
  </style>
</head>
<body>
  <canvas id="app"></canvas>
  <div id="hud"></div>
  <div id="nogl"><p>GROUNDWORK needs WebGL, which this browser doesn't support.</p></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`src/main.ts` (placeholder proving the pipeline; replaced in Task 4):
```ts
console.log('groundwork boot');
```

`.gitignore`: `node_modules/`, `dist/`.

`.github/workflows/deploy.yml`:
```yaml
name: deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Install and verify**

Run: `npm install && npm run build && npm test`
Expected: build succeeds, `dist/index.html` exists, `npm test` exits 0 via `--passWithNoTests` (no dummy tests).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold vite+ts+three project with pages deploy workflow"
```

---

### Task 2: Core — RNG, event bus, fixed-timestep loop, shared types

**Files:**
- Create: `src/core/constants.ts`, `src/core/types.ts`, `src/core/rng.ts`, `src/core/events.ts`, `src/core/loop.ts`
- Test: `tests/rng.test.ts`, `tests/events.test.ts`, `tests/loop.test.ts`

**Interfaces:**
- Produces:
  - `createRng(seed: string): () => number` — deterministic float in [0,1)
  - `class EventBus` with `on<K>(type, fn): () => void` (returns unsubscribe) and `emit<K>(type, payload)`
  - `interface GameEvents` — the full event map used by ALL later tasks (verbatim below)
  - `class Loop { constructor(update: (dt: number) => void, render: (alpha: number) => void); timeScale: number; start(): void; stop(): void }` — fixed `SIM_DT` accumulator, `timeScale` multiplies accumulated time, calls at most 8 updates per frame (spiral-of-death guard)
  - Types: `V3 {x,y,z}`, `P2 {x,z}`, `Stage`, `STAGES`, `VehicleKind`, `RoadSample`

- [ ] **Step 1: Write failing tests**

`tests/rng.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createRng } from '../src/core/rng';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('island-7'), b = createRng('island-7');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it('differs across seeds', () => {
    expect(createRng('a')()).not.toEqual(createRng('b')());
  });
  it('stays in [0,1)', () => {
    const r = createRng('x');
    for (let i = 0; i < 1000; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
```

`tests/events.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/events';

describe('EventBus', () => {
  it('delivers payloads to subscribers and honors unsubscribe', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on('roads:edgeAdded', (e) => seen.push(e.edgeId));
    bus.emit('roads:edgeAdded', { edgeId: 1 });
    off();
    bus.emit('roads:edgeAdded', { edgeId: 2 });
    expect(seen).toEqual([1]);
  });
});
```

`tests/loop.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { stepAccumulator } from '../src/core/loop';

describe('stepAccumulator', () => {
  it('produces fixed-size steps and a remainder alpha', () => {
    const r = stepAccumulator(0.05, 1 / 60, 8); // 50ms at 60Hz -> 3 steps
    expect(r.steps).toBe(3);
    expect(r.remainder).toBeCloseTo(0.05 - 3 / 60, 10);
  });
  it('caps runaway steps', () => {
    expect(stepAccumulator(10, 1 / 60, 8).steps).toBe(8);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/core/constants.ts`:
```ts
export const WORLD_SIZE = 512;
export const GRID_SIZE = 129;
export const CELL = WORLD_SIZE / (GRID_SIZE - 1); // 4
export const SNAP = 8;
export const WATER_LEVEL = 0;
export const ROAD_WIDTH = 6;
export const LANE_OFFSET = 1.5;
export const MAX_ROAD_GRADE = 0.35;
export const SIM_DT = 1 / 60;
export const DAY_LENGTH = 240;
```

`src/core/types.ts`:
```ts
export interface V3 { x: number; y: number; z: number; }
export interface P2 { x: number; z: number; }
export type Stage = 'surveyed' | 'graded' | 'gravel' | 'paved' | 'painted';
export const STAGES: Stage[] = ['surveyed', 'graded', 'gravel', 'paved', 'painted'];
export type VehicleKind = 'excavator' | 'truck' | 'paver' | 'roller' | 'liner';
export interface RoadSample extends V3 { bridge: boolean; }
```

`src/core/rng.ts` (xmur3 hash → mulberry32):
```ts
export function createRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`src/core/events.ts` — the COMPLETE event map (later tasks add no new event types; they use these):
```ts
import type { Stage, V3, VehicleKind } from './types';

export interface GameEvents {
  'roads:changed': Record<string, never>;                     // any topology/stage change relevant to lanes+growth
  'roads:edgeAdded': { edgeId: number };
  'roads:edgeRemoved': { edgeId: number };
  'construction:stage': { edgeId: number; stage: Stage | 'removed' };
  'construction:progress': { edgeId: number; stage: Stage; t: number; pos: V3; heading: number; vehicle: VehicleKind; demolish: boolean };
  'terrain:deformed': { minI: number; minJ: number; maxI: number; maxJ: number };
  'growth:spawn': { kind: 'tree' | 'field' | 'house' | 'building'; x: number; z: number; rot: number };
  'atmosphere:phase': { night: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>();
  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as Handler<GameEvents[K]>)(payload));
  }
}
```

`src/core/loop.ts`:
```ts
import { SIM_DT } from './constants';

export function stepAccumulator(acc: number, dt: number, maxSteps: number): { steps: number; remainder: number } {
  let steps = Math.floor(acc / dt);
  if (steps > maxSteps) steps = maxSteps;
  return { steps, remainder: Math.min(acc - steps * dt, dt) };
}

export class Loop {
  timeScale = 1;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  constructor(private update: (dt: number) => void, private render: (alpha: number) => void) {}
  start(): void {
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.acc += Math.min((now - this.last) / 1000, 0.25) * this.timeScale;
      this.last = now;
      const { steps, remainder } = stepAccumulator(this.acc, SIM_DT, 8);
      for (let i = 0; i < steps; i++) this.update(SIM_DT);
      this.acc = remainder;
      this.render(this.acc / SIM_DT);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: core rng, typed event bus, fixed-timestep loop"
```

---

### Task 3: Heightfield — procedural island terrain (sim only)

**Files:**
- Create: `src/sim/terrain/heightfield.ts`
- Test: `tests/heightfield.test.ts`

**Interfaces:**
- Consumes: `createRng`, constants, `EventBus` (emits `terrain:deformed`).
- Produces `class Heightfield`:
  - `constructor(seed: string, bus?: EventBus)` — builds `heights: Float32Array(GRID_SIZE * GRID_SIZE)`; index `j * GRID_SIZE + i`; world x = `i * CELL - WORLD_SIZE/2`, z = `j * CELL - WORLD_SIZE/2`.
  - `heightAt(x: number, z: number): number` — bilinear interpolation, clamped to grid bounds.
  - `isLand(x: number, z: number): boolean` — `heightAt > WATER_LEVEL + 0.4`.
  - `flattenCircle(x: number, z: number, targetY: number, radius: number): void` — blends grid heights toward `targetY` with smoothstep falloff by distance; emits `terrain:deformed` with the dirty cell rect.
  - `slopeAt(x: number, z: number): number` — |gradient| magnitude from central differences.

- [ ] **Step 1: Write failing tests**

`tests/heightfield.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { EventBus } from '../src/core/events';
import { WORLD_SIZE, WATER_LEVEL } from '../src/core/constants';

describe('Heightfield', () => {
  it('is deterministic per seed', () => {
    const a = new Heightfield('s1'), b = new Heightfield('s1');
    expect(a.heightAt(10, -30)).toBeCloseTo(b.heightAt(10, -30), 10);
  });
  it('is underwater at the world border (island falloff)', () => {
    const hf = new Heightfield('s1');
    const e = WORLD_SIZE / 2 - 1;
    for (const [x, z] of [[e, 0], [-e, 0], [0, e], [0, -e]] as const)
      expect(hf.heightAt(x, z)).toBeLessThan(WATER_LEVEL);
  });
  it('has land somewhere near the center', () => {
    const hf = new Heightfield('s1');
    let found = false;
    for (let x = -100; x <= 100 && !found; x += 10)
      for (let z = -100; z <= 100 && !found; z += 10)
        if (hf.isLand(x, z)) found = true;
    expect(found).toBe(true);
  });
  it('flattenCircle moves heights toward target and emits dirty rect', () => {
    const bus = new EventBus();
    const hf = new Heightfield('s1', bus);
    let rect: unknown = null;
    bus.on('terrain:deformed', (r) => (rect = r));
    const before = hf.heightAt(0, 0);
    hf.flattenCircle(0, 0, before + 5, 12);
    expect(hf.heightAt(0, 0)).toBeGreaterThan(before + 4);
    expect(rect).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npm test`, FAIL (module missing).

- [ ] **Step 3: Implement**

`src/sim/terrain/heightfield.ts`:
```ts
import { createNoise2D } from 'simplex-noise';
import { createRng } from '../../core/rng';
import { EventBus } from '../../core/events';
import { GRID_SIZE, CELL, WORLD_SIZE, WATER_LEVEL } from '../../core/constants';

export class Heightfield {
  readonly heights = new Float32Array(GRID_SIZE * GRID_SIZE);

  constructor(public readonly seed: string, private bus?: EventBus) {
    const noise = createNoise2D(createRng(seed));
    const half = WORLD_SIZE / 2;
    for (let j = 0; j < GRID_SIZE; j++) {
      for (let i = 0; i < GRID_SIZE; i++) {
        const x = i * CELL - half, z = j * CELL - half;
        // 4-octave fbm
        let amp = 1, freq = 1 / 180, h = 0, norm = 0;
        for (let o = 0; o < 4; o++) {
          h += noise(x * freq, z * freq) * amp;
          norm += amp; amp *= 0.5; freq *= 2.1;
        }
        h = (h / norm) * 0.5 + 0.5;          // 0..1
        h = Math.pow(h, 1.3) * 30 - 5;        // -5..25, biased low
        const d = Math.hypot(x, z) / half;    // radial island falloff
        h -= smoothstep(0.62, 1.0, d) * 40;
        this.heights[j * GRID_SIZE + i] = h;
      }
    }
  }

  private grid(i: number, j: number): number {
    i = Math.max(0, Math.min(GRID_SIZE - 1, i));
    j = Math.max(0, Math.min(GRID_SIZE - 1, j));
    return this.heights[j * GRID_SIZE + i];
  }

  heightAt(x: number, z: number): number {
    const half = WORLD_SIZE / 2;
    const fi = (x + half) / CELL, fj = (z + half) / CELL;
    const i = Math.floor(fi), j = Math.floor(fj);
    const u = fi - i, v = fj - j;
    const h00 = this.grid(i, j), h10 = this.grid(i + 1, j);
    const h01 = this.grid(i, j + 1), h11 = this.grid(i + 1, j + 1);
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  }

  isLand(x: number, z: number): boolean { return this.heightAt(x, z) > WATER_LEVEL + 0.4; }

  slopeAt(x: number, z: number): number {
    const e = CELL;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }

  flattenCircle(x: number, z: number, targetY: number, radius: number): void {
    const half = WORLD_SIZE / 2;
    const minI = Math.max(0, Math.floor((x - radius + half) / CELL));
    const maxI = Math.min(GRID_SIZE - 1, Math.ceil((x + radius + half) / CELL));
    const minJ = Math.max(0, Math.floor((z - radius + half) / CELL));
    const maxJ = Math.min(GRID_SIZE - 1, Math.ceil((z + radius + half) / CELL));
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const wx = i * CELL - half, wz = j * CELL - half;
        const d = Math.hypot(wx - x, wz - z) / radius;
        if (d >= 1) continue;
        const w = 1 - smoothstep(0.35, 1.0, d);   // full strength in core, feathered rim
        const idx = j * GRID_SIZE + i;
        this.heights[idx] += (targetY - this.heights[idx]) * w;
      }
    }
    this.bus?.emit('terrain:deformed', { minI, minJ, maxI, maxJ });
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: procedural island heightfield with deformation"`

---

### Task 4: Scene, terrain + water rendering, camera rig

**Files:**
- Create: `src/render/scene.ts`, `src/render/terrainRenderer.ts`, `src/render/easing.ts`, `src/input/cameraRig.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `Heightfield` (heights array, dims), `EventBus` (`terrain:deformed`), `Loop`.
- Produces:
  - `createScene(canvas: HTMLCanvasElement): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight }` — sRGB output, ACES tone mapping, shadowMap enabled (2048), resize handler.
  - `class TerrainRenderer { constructor(scene, hf: Heightfield, bus: EventBus); mesh: THREE.Mesh; water: THREE.Mesh; refreshRegion(minI,minJ,maxI,maxJ): void }` — plane geometry GRID_SIZE² verts, y from heightfield, per-vertex colors: sand `#c9b98a` below y=1, grass `#7fae6b` to y=14, rock `#8d8577` above / where slope > 0.6; listens to `terrain:deformed` to update positions+colors+normals in the dirty rect only. Water: translucent flat plane at `WATER_LEVEL`, color `#3d7ea6`, opacity 0.82.
  - `class CameraRig { constructor(camera, domElement); update(dt): void; target: THREE.Vector3; idle: boolean }` — custom damped orbit: LMB-drag reserved for the draw tool, so orbit = RMB-drag, pan = MMB-drag or WASD, zoom = wheel (dolly toward cursor). All motion critically damped (`current += (goal - current) * (1 - Math.exp(-8 * dt))`). After 20s with no input sets `idle = true` and slowly orbits (0.02 rad/s); any input resets.
  - `src/main.ts` wires: seed `'terra-1'`, Heightfield, scene, terrain, rig, Loop with empty `update`, renders scene. WebGL guard: wrap `new THREE.WebGLRenderer(...)` in try/catch and also check `canvas.getContext('webgl2') ?? canvas.getContext('webgl')`; on failure hide `#app`, set `#nogl` to `display: grid`, and skip all further init.

- [ ] **Step 1: Implement** the four files and wire `main.ts`. `easing.ts`:
```ts
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const damp = (cur: number, goal: number, lambda: number, dt: number) => cur + (goal - cur) * (1 - Math.exp(-lambda * dt));
```
Terrain geometry: `THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID_SIZE-1, GRID_SIZE-1)` rotated -90° about X, then overwrite each vertex y from `hf.heights` (note plane vertex order matches i across, j down after rotation — verify by logging one row). Material `MeshStandardMaterial({ vertexColors: true, flatShading: true })`. Recompute normals after edits. Water gets `depthWrite: false`.

- [ ] **Step 2: Visual verification**

Run: `npm run dev`, open browser. Verify against checklist: island visible with sand ring, water surrounds it, camera orbits with smooth damping (RMB), zoom dollies smoothly, no console errors, ~60fps in devtools performance. Take a screenshot for the record.

- [ ] **Step 3: Build check + commit**

Run: `npm run build` — passes. `git add -A && git commit -m "feat: terrain and water rendering with damped camera rig"`

---

### Task 5: Road graph — nodes, edges, snapping, chain commit, edge splitting (sim only)

**Files:**
- Create: `src/sim/roads/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: `P2`, `RoadSample`, `Stage`, `SNAP`, `EventBus`.
- Produces `class RoadGraph`:
  - `constructor(bus: EventBus, sampler: (ctrl: P2[]) => RoadSample[])` — sampler injected (Task 6 provides the real one; tests use a stub).
  - `static snap(x: number, z: number): P2` — round to SNAP grid.
  - `nodes: Map<number, { id: number; x: number; z: number }>`, `edges: Map<number, RoadEdge>` where `RoadEdge = { id: number; a: number; b: number; ctrl: P2[]; samples: RoadSample[]; length: number; stage: Stage }` (`ctrl` includes both endpoints, all snapped; `length` = sampled polyline length).
  - `commitChain(rawCtrl: P2[]): number[]` — snaps + dedupes consecutive points; splits the chain at every point that coincides with an existing node OR an existing edge's interior control point (calling `splitEdge` for the latter); creates nodes at chain ends and split points; creates one edge per sub-chain with `stage: 'surveyed'`; emits `roads:edgeAdded` per edge and one `roads:changed`. Returns new edge ids.
  - `splitEdge(edgeId: number, ctrlIndex: number): { nodeId: number; left: number; right: number }` — replaces edge with two edges sharing a new node at `ctrl[ctrlIndex]`; both inherit `stage`; resamples both.
  - `removeEdge(edgeId: number): void` — deletes edge, prunes now-orphaned degree-0 nodes, emits `roads:edgeRemoved` + `roads:changed`.
  - `edgesAtNode(nodeId: number): number[]`.
  - Internal point index `Map<string, { kind: 'node' | 'edge'; id: number; ctrlIndex?: number }>` keyed `"x,z"` for all node positions and interior edge control points.

- [ ] **Step 1: Write failing tests**

`tests/graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';

const stubSampler = (ctrl: P2[]): RoadSample[] =>
  ctrl.map((p) => ({ x: p.x, y: 1, z: p.z, bridge: false }));

const mk = () => new RoadGraph(new EventBus(), stubSampler);

describe('RoadGraph', () => {
  it('snaps to the SNAP grid', () => {
    expect(RoadGraph.snap(11, -3)).toEqual({ x: 8, z: 0 });
  });
  it('commits a simple chain as one edge with end nodes', () => {
    const g = mk();
    const ids = g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }]);
    expect(ids).toHaveLength(1);
    expect(g.nodes.size).toBe(2);
    expect(g.edges.get(ids[0])!.stage).toBe('surveyed');
    expect(g.edges.get(ids[0])!.ctrl).toHaveLength(3);
  });
  it('splits a new chain at an existing node (T junction)', () => {
    const g = mk();
    g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    const ids = g.commitChain([{ x: 16, z: 0 }, { x: 16, z: 16 }]);
    expect(ids).toHaveLength(1);
    expect(g.nodes.size).toBe(3);
  });
  it('splits an existing edge when a chain touches its interior control point', () => {
    const g = mk();
    const [first] = g.commitChain([{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 16, z: 0 }]);
    g.commitChain([{ x: 8, z: 0 }, { x: 8, z: 16 }]);
    expect(g.edges.has(first)).toBe(false);     // original replaced
    expect(g.edges.size).toBe(3);               // two halves + the new road
    expect(g.nodes.size).toBe(4);
  });
  it('removeEdge prunes orphan nodes and emits events', () => {
    const bus = new EventBus();
    const g = new RoadGraph(bus, stubSampler);
    let removed = -1;
    bus.on('roads:edgeRemoved', (e) => (removed = e.edgeId));
    const [id] = g.commitChain([{ x: 0, z: 0 }, { x: 16, z: 0 }]);
    g.removeEdge(id);
    expect(removed).toBe(id);
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.** — `npm test`

- [ ] **Step 3: Implement**

`src/sim/roads/graph.ts`:
```ts
import { SNAP } from '../../core/constants';
import type { P2, RoadSample, Stage } from '../../core/types';
import { EventBus } from '../../core/events';

export interface RoadEdge {
  id: number; a: number; b: number;
  ctrl: P2[]; samples: RoadSample[]; length: number; stage: Stage;
}

const key = (p: P2) => `${p.x},${p.z}`;

export class RoadGraph {
  nodes = new Map<number, { id: number; x: number; z: number }>();
  edges = new Map<number, RoadEdge>();
  private points = new Map<string, { kind: 'node' | 'edge'; id: number; ctrlIndex?: number }>();
  private nextNode = 1;
  private nextEdge = 1;

  constructor(private bus: EventBus, private sampler: (ctrl: P2[]) => RoadSample[]) {}

  static snap(x: number, z: number): P2 {
    return { x: Math.round(x / SNAP) * SNAP, z: Math.round(z / SNAP) * SNAP };
  }

  private polyLength(s: RoadSample[]): number {
    let L = 0;
    for (let i = 1; i < s.length; i++) L += Math.hypot(s[i].x - s[i-1].x, s[i].y - s[i-1].y, s[i].z - s[i-1].z);
    return L;
  }

  private addNode(p: P2): number {
    const existing = this.points.get(key(p));
    if (existing?.kind === 'node') return existing.id;
    if (existing?.kind === 'edge') return this.splitEdge(existing.id, existing.ctrlIndex!).nodeId;
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    return id;
  }

  private makeEdge(a: number, b: number, ctrl: P2[], stage: Stage): number {
    const id = this.nextEdge++;
    const samples = this.sampler(ctrl);
    this.edges.set(id, { id, a, b, ctrl, samples, length: this.polyLength(samples), stage });
    for (let i = 1; i < ctrl.length - 1; i++) {
      if (!this.points.has(key(ctrl[i]))) this.points.set(key(ctrl[i]), { kind: 'edge', id, ctrlIndex: i });
    }
    return id;
  }

  private unindexEdge(e: RoadEdge): void {
    for (let i = 1; i < e.ctrl.length - 1; i++) {
      const rec = this.points.get(key(e.ctrl[i]));
      if (rec?.kind === 'edge' && rec.id === e.id) this.points.delete(key(e.ctrl[i]));
    }
  }

  splitEdge(edgeId: number, ctrlIndex: number): { nodeId: number; left: number; right: number } {
    const e = this.edges.get(edgeId)!;
    this.unindexEdge(e);
    this.edges.delete(edgeId);
    const p = e.ctrl[ctrlIndex];
    const id = this.nextNode++;
    this.nodes.set(id, { id, x: p.x, z: p.z });
    this.points.set(key(p), { kind: 'node', id });
    const left = this.makeEdge(e.a, id, e.ctrl.slice(0, ctrlIndex + 1), e.stage);
    const right = this.makeEdge(id, e.b, e.ctrl.slice(ctrlIndex), e.stage);
    this.bus.emit('roads:edgeRemoved', { edgeId });
    this.bus.emit('roads:edgeAdded', { edgeId: left });
    this.bus.emit('roads:edgeAdded', { edgeId: right });
    return { nodeId: id, left, right };
  }

  commitChain(rawCtrl: P2[]): number[] {
    const ctrl: P2[] = [];
    for (const r of rawCtrl) {
      const p = RoadGraph.snap(r.x, r.z);
      if (!ctrl.length || key(ctrl[ctrl.length - 1]) !== key(p)) ctrl.push(p);
    }
    if (ctrl.length < 2) return [];
    // find split positions: interior chain points that hit existing nodes/edge points
    const cuts = [0];
    for (let i = 1; i < ctrl.length - 1; i++) if (this.points.has(key(ctrl[i]))) cuts.push(i);
    cuts.push(ctrl.length - 1);
    const ids: number[] = [];
    for (let c = 0; c < cuts.length - 1; c++) {
      const sub = ctrl.slice(cuts[c], cuts[c + 1] + 1);
      const a = this.addNode(sub[0]);
      const b = this.addNode(sub[sub.length - 1]);
      if (a === b) continue;
      const id = this.makeEdge(a, b, sub, 'surveyed');
      ids.push(id);
      this.bus.emit('roads:edgeAdded', { edgeId: id });
    }
    if (ids.length) this.bus.emit('roads:changed', {});
    return ids;
  }

  removeEdge(edgeId: number): void {
    const e = this.edges.get(edgeId);
    if (!e) return;
    this.unindexEdge(e);
    this.edges.delete(edgeId);
    for (const nid of [e.a, e.b]) {
      if (this.edgesAtNode(nid).length === 0) {
        const n = this.nodes.get(nid)!;
        this.points.delete(key({ x: n.x, z: n.z }));
        this.nodes.delete(nid);
      }
    }
    this.bus.emit('roads:edgeRemoved', { edgeId });
    this.bus.emit('roads:changed', {});
  }

  edgesAtNode(nodeId: number): number[] {
    const out: number[] = [];
    for (const e of this.edges.values()) if (e.a === nodeId || e.b === nodeId) out.push(e.id);
    return out;
  }
}
```

- [ ] **Step 4: Run tests, verify pass.** `npm test`
- [ ] **Step 5: Commit** — `git commit -am "feat: road graph with snapping, chain commit, and edge splitting"`

---

### Task 6: Road path sampling — curves, elevation smoothing, bridges, validity (sim only)

**Files:**
- Create: `src/sim/roads/path.ts`
- Test: `tests/path.test.ts`

**Interfaces:**
- Consumes: `Heightfield`, constants, `P2`, `RoadSample`.
- Produces:
  - `makeSampler(hf: Heightfield): (ctrl: P2[]) => RoadSample[]` — the real sampler injected into `RoadGraph`:
    1. Catmull-Rom spline through `ctrl` (endpoints duplicated), sampled every ~2 world units.
    2. Base elevation per sample: `max(hf.heightAt(x,z), WATER_LEVEL + 2.5 if heightAt < WATER_LEVEL + 0.4 else heightAt)`.
    3. Slope-limit smoothing: forward then backward pass raising y so |Δy| ≤ `MAX_ROAD_GRADE * spacing` (fills dips → causes bridges over valleys/water).
    4. `bridge = y - hf.heightAt(x,z) > 1.2`.
  - `validateChain(ctrl: P2[], hf: Heightfield): boolean` — true iff ≥ 2 distinct snapped points, all points within `|x|,|z| ≤ WORLD_SIZE/2 - SNAP`, and first & last points on land (`hf.isLand`). (Middle may cross water → bridge.)
  - `sampleAt(samples: RoadSample[], t: number): { pos: V3; heading: number }` — position + XZ heading (radians) at arclength `t`, used by construction vehicles and traffic.

- [ ] **Step 1: Write failing tests**

`tests/path.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeSampler, validateChain, sampleAt } from '../src/sim/roads/path';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { MAX_ROAD_GRADE, WATER_LEVEL } from '../src/core/constants';

const hf = new Heightfield('path-test');
// find a guaranteed-land point to anchor tests
function landPoint(): { x: number; z: number } {
  for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 48, z)) return { x, z };
  throw new Error('no land');
}

describe('road path sampling', () => {
  it('samples a curve at ~2u spacing with no grade over the limit', () => {
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 24, z: p.z }, { x: p.x + 48, z: p.z }]);
    expect(s.length).toBeGreaterThan(10);
    for (let i = 1; i < s.length; i++) {
      const run = Math.hypot(s[i].x - s[i-1].x, s[i].z - s[i-1].z);
      expect(Math.abs(s[i].y - s[i-1].y) / run).toBeLessThanOrEqual(MAX_ROAD_GRADE + 1e-6);
    }
  });
  it('keeps deck above water and flags bridge samples over water', () => {
    // straight chain across the island edge into water and back is hard to construct
    // generically, so instead assert: any sample whose ground is underwater is a bridge
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }]);
    for (const smp of s) {
      if (hf.heightAt(smp.x, smp.z) < WATER_LEVEL + 0.4) {
        expect(smp.bridge).toBe(true);
        expect(smp.y).toBeGreaterThanOrEqual(WATER_LEVEL + 2.0);
      }
    }
  });
  it('validates chains: rejects single point and off-world, accepts land-to-land', () => {
    const p = landPoint();
    expect(validateChain([{ x: p.x, z: p.z }], hf)).toBe(false);
    expect(validateChain([{ x: p.x, z: p.z }, { x: 9999, z: 0 }], hf)).toBe(false);
    expect(validateChain([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }], hf)).toBe(true);
  });
  it('sampleAt interpolates position and heading along arclength', () => {
    const p = landPoint();
    const s = makeSampler(hf)([{ x: p.x, z: p.z }, { x: p.x + 48, z: p.z }]);
    const mid = sampleAt(s, 24);
    expect(mid.pos.x).toBeGreaterThan(p.x + 16);
    expect(mid.pos.x).toBeLessThan(p.x + 32);
    expect(Math.abs(Math.cos(mid.heading))).toBeGreaterThan(0.9); // heading ~ +x
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement**

`src/sim/roads/path.ts`:
```ts
import type { P2, RoadSample, V3 } from '../../core/types';
import { Heightfield } from '../terrain/heightfield';
import { MAX_ROAD_GRADE, WATER_LEVEL, WORLD_SIZE, SNAP } from '../../core/constants';

const SPACING = 2;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

export function makeSampler(hf: Heightfield) {
  return (ctrl: P2[]): RoadSample[] => {
    const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
    const flat: P2[] = [];
    for (let seg = 0; seg < ctrl.length - 1; seg++) {
      const [p0, p1, p2, p3] = [pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3]];
      const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const n = Math.max(2, Math.ceil(segLen / SPACING));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        flat.push({ x: catmullRom(p0.x, p1.x, p2.x, p3.x, t), z: catmullRom(p0.z, p1.z, p2.z, p3.z, t) });
      }
    }
    flat.push({ ...ctrl[ctrl.length - 1] });

    // base elevation
    const ground = flat.map((p) => hf.heightAt(p.x, p.z));
    const y = ground.map((g) => (g < WATER_LEVEL + 0.4 ? Math.max(g, WATER_LEVEL + 2.5) : g));
    // slope-limit smoothing (raise-only passes fill dips)
    for (let i = 1; i < y.length; i++) {
      const run = Math.hypot(flat[i].x - flat[i-1].x, flat[i].z - flat[i-1].z);
      y[i] = Math.max(y[i], y[i - 1] - MAX_ROAD_GRADE * run);
    }
    for (let i = y.length - 2; i >= 0; i--) {
      const run = Math.hypot(flat[i+1].x - flat[i].x, flat[i+1].z - flat[i].z);
      y[i] = Math.max(y[i], y[i + 1] - MAX_ROAD_GRADE * run);
    }
    return flat.map((p, i) => ({ x: p.x, y: y[i], z: p.z, bridge: y[i] - ground[i] > 1.2 }));
  };
}

export function validateChain(ctrl: P2[], hf: Heightfield): boolean {
  if (ctrl.length < 2) return false;
  const lim = WORLD_SIZE / 2 - SNAP;
  for (const p of ctrl) if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) return false;
  return hf.isLand(ctrl[0].x, ctrl[0].z) && hf.isLand(ctrl[ctrl.length - 1].x, ctrl[ctrl.length - 1].z);
}

export function sampleAt(samples: RoadSample[], t: number): { pos: V3; heading: number } {
  let acc = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (acc + seg >= t || i === samples.length - 1) {
      const u = seg > 0 ? Math.max(0, Math.min(1, (t - acc) / seg)) : 0;
      return {
        pos: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u },
        heading: Math.atan2(b.z - a.z, b.x - a.x),
      };
    }
    acc += seg;
  }
  const last = samples[samples.length - 1];
  return { pos: { ...last }, heading: 0 };
}
```

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat: road curve sampling with grade smoothing, bridges, validation"`

---

### Task 7: Road rendering — stage ribbons, center line, bridges

**Files:**
- Create: `src/render/roadRenderer.ts`
- Modify: `src/main.ts` (instantiate RoadGraph with real sampler + RoadRenderer; add a temporary `window.__debugRoad(chain)` hook to commit a test chain from the console)

**Interfaces:**
- Consumes: `RoadGraph` (edges + samples), `EventBus` (`roads:edgeAdded/Removed`, `construction:stage`, `construction:progress`).
- Produces `class RoadRenderer { constructor(scene, graph, bus); update(dt): void }`:
  - Per edge, a `THREE.Group` containing stage geometry, rebuilt on stage events.
  - `buildRibbonGeometry(samples: RoadSample[], width: number, yLift: number, from: number, to: number): THREE.BufferGeometry` — exported helper: triangle strip between left/right offsets (perpendicular in XZ per sample), spanning arclength `[from, to]`.
  - Stage appearance (all `MeshStandardMaterial`, flatShading):
    - `surveyed`: dashed center preview only — thin ribbon width 0.8, color `#e8641b`, opacity 0.55, dash via alternating segments (skip every other 2u sample pair).
    - `graded`: full-width ribbon, dirt `#8a6f4d`, yLift 0.06.
    - `gravel`: ribbon `#9b958a`, yLift 0.12.
    - `paved`: ribbon `#3c3f41`, yLift 0.18. Fresh asphalt sheen: material starts at roughness 0.35 and lerps to 0.9 over 25s after the stage event (tracked per edge, advanced in `update`).
    - `painted`: adds dashed center-line ribbon width 0.35, color `#e8e4d8`, yLift 0.24.
  - **Partial progress:** on `construction:progress` for edge stage S at arclength t, render `[0, t]` in stage S appearance and `[t, length]` in the previous stage's appearance (two ribbons; rebuild geometry at most every 0.15s per edge, throttled).
  - **Bridges:** for maximal consecutive bridge sample runs, add side-rail boxes (0.4 × 0.8 cross-section along edges) and cylinder pylons (r 0.9) every 16u from deck to ground; pylons/deck colored `#7a7a72`.
  - On `construction:stage` `'removed'`, dispose group.

- [ ] **Step 1: Implement** `roadRenderer.ts` with the exported `buildRibbonGeometry` (positions + normals up + index; dispose old geometry on rebuild).

- [ ] **Step 2: Visual verification**

`main.ts` hook:
```ts
(window as unknown as { __debugRoad: (pts: [number, number][]) => void }).__debugRoad =
  (pts) => { graph.commitChain(pts.map(([x, z]) => ({ x, z }))); };
```
In the browser console run `__debugRoad([[0,0],[40,8],[80,0],[120,-24]])` then manually set the edge's stage to each value and re-emit `construction:stage` (or temporarily default new edges to `painted`). Checklist: smooth curved ribbon following terrain, center dashes visible when painted, a chain crossing water shows deck + pylons + rails. Screenshot.

- [ ] **Step 3: Commit** — `git commit -am "feat: staged road ribbon rendering with bridges"`

---

### Task 8: Draw tool — survey preview, stakes, commit; demolish mode

**Files:**
- Create: `src/input/drawTool.ts`
- Modify: `src/main.ts` (wire tool; remove `__debugRoad`)

**Interfaces:**
- Consumes: `RoadGraph`, `validateChain`, `Heightfield`, terrain mesh (raycast target), camera, `EventBus`.
- Produces `class DrawTool`:
  - `constructor(dom: HTMLElement, camera, terrainMesh, graph, hf, scene)`
  - `mode: 'draw' | 'demolish' | 'none'` (HUD sets this in Task 15; default `'draw'`).
  - Draw: `pointerdown` (LMB) starts a chain at the snapped raycast hit; `pointermove` appends a snapped point when the cursor's snapped position differs from the last (magnetic feel comes free from snapping); `pointerup` commits via `graph.commitChain` **iff** `validateChain` passes, else the preview fades out over 0.3s.
  - Preview rendering (owned by the tool): dashed orange line (`THREE.Line` with `LineDashedMaterial`, color `#e8641b`) elevated 0.4 above sampled path using the REAL sampler (so the player previews bridges too), plus small stake cylinders (r 0.1, h 0.9) at control points. While invalid, line + stakes tint red `#c0392b`.
  - Demolish: click near an edge (raycast against road groups — tag each road group `userData.edgeId`) → calls `queue.enqueueDemolish(edgeId)` (queue arrives in Task 9; until then call `graph.removeEdge` directly and leave a `// Task 9 swaps this to queue.enqueueDemolish` note).
  - Hover cursor: a soft ring mesh at the snapped point, breathing scale ±5% at 0.5Hz.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Visual verification** — dev server: drag draws a snapping dashed survey line with stakes; releasing over a valid route leaves a surveyed dashed preview road; invalid (endpoint in water) tints red and fades on release; demolish click removes a road. Screenshot.
- [ ] **Step 3: Commit** — `git commit -am "feat: draw tool with survey preview, stakes, demolish"`

---

### Task 9: Construction queue — stage FSM + vehicle progress (sim only)

**Files:**
- Create: `src/sim/construction/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `RoadGraph` (edges, removeEdge), `Heightfield.flattenCircle`, `sampleAt`, `EventBus`, `STAGES`.
- Produces `class BuildQueue`:
  - `constructor(graph: RoadGraph, hf: Heightfield, bus: EventBus)`
  - Subscribes to `roads:edgeAdded` → auto-enqueues build jobs (FIFO). One active job at a time (one crew).
  - `enqueueDemolish(edgeId: number): void` — demolish jobs jump the queue.
  - `update(dt: number): void` — advances the active job: vehicle moves along the edge at the stage speed; when `t ≥ edge.length`, advance stage, reset `t`, emit `construction:stage`; after `painted`, emit `roads:changed` and pop next job. Demolish walks stages in reverse (vehicle `excavator` for all reverse stages) and ends with `graph.removeEdge`.
  - Stage speeds (units/sec) and vehicles: `graded`: 6/`excavator`, `gravel`: 8/`truck`, `paved`: 5/`paver` (a `roller` trails 8u behind the paver in the same pass — renderer detail, same progress event), `painted`: 12/`liner`. (`surveyed` is instant — it's the state edges are born in.)
  - During `graded`, each update calls `hf.flattenCircle(pos.x, pos.z, pos.y, ROAD_WIDTH * 1.4)` at the vehicle position **only for non-bridge samples**.
  - Emits `construction:progress` every update with `{edgeId, stage, t, pos, heading, vehicle, demolish}`.
  - `get busy(): boolean`, `get queueLength(): number`.

- [ ] **Step 1: Write failing tests**

`tests/queue.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BuildQueue } from '../src/sim/construction/queue';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import type { Stage } from '../src/core/types';

function setup() {
  const bus = new EventBus();
  const hf = new Heightfield('q-test', bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  // find land chain
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
  const [edgeId] = graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
  return { bus, hf, graph, queue, edgeId };
}

const run = (queue: BuildQueue, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) queue.update(1 / 60);
};

describe('BuildQueue', () => {
  it('advances an edge through all stages in order', () => {
    const { bus, queue, edgeId, graph } = setup();
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => { if (e.edgeId === edgeId) stages.push(e.stage); });
    run(queue, 120);
    expect(stages).toEqual(['graded', 'gravel', 'paved', 'painted']);
    expect(graph.edges.get(edgeId)!.stage).toBe('painted');
    expect(queue.busy).toBe(false);
  });
  it('grading deforms terrain toward the road profile', () => {
    const { queue, hf, graph, edgeId } = setup();
    const mid = graph.edges.get(edgeId)!.samples[Math.floor(graph.edges.get(edgeId)!.samples.length / 2)];
    run(queue, 120);
    expect(Math.abs(hf.heightAt(mid.x, mid.z) - mid.y)).toBeLessThan(1.0);
  });
  it('demolish reverses stages and removes the edge', () => {
    const { bus, queue, graph, edgeId } = setup();
    run(queue, 120); // fully built
    const stages: (Stage | 'removed')[] = [];
    bus.on('construction:stage', (e) => stages.push(e.stage));
    queue.enqueueDemolish(edgeId);
    run(queue, 120);
    expect(stages[stages.length - 1]).toBe('removed');
    expect(graph.edges.has(edgeId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `queue.ts`. Core loop sketch (full implementation must match interfaces above):
```ts
const STAGE_SPEED: Record<Exclude<Stage, 'surveyed'>, number> = { graded: 6, gravel: 8, paved: 5, painted: 12 };
const STAGE_VEHICLE: Record<Exclude<Stage, 'surveyed'>, VehicleKind> = { graded: 'excavator', gravel: 'truck', paved: 'paver', painted: 'liner' };
```
Active job `{ edgeId, stageIndex, t, demolish }`. On update: `t += speed * dt`; compute `sampleAt(edge.samples, t)`; grading deform (skip bridge samples: find nearest sample index, check `.bridge`); emit progress; on `t >= length` → next stage (or previous when demolishing; when stepping below `graded` → `graph.removeEdge`, emit `'construction:stage'` with `'removed'`). Guard: if the edge was removed externally, drop the job.

- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Wire into `main.ts`** — instantiate BuildQueue, call `queue.update(dt)` in the Loop's update; swap DrawTool demolish to `queue.enqueueDemolish`. Verify in dev server: drawing a road now shows it building stage by stage (ribbon transitions with partial progress from Task 7).
- [ ] **Step 6: Commit** — `git commit -am "feat: construction queue with staged builds, grading deform, demolition"`

---

### Task 10: Construction vehicles + work effects

**Files:**
- Create: `src/render/constructionRenderer.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `construction:progress`, `construction:stage` events, `easing.ts`.
- Produces `class ConstructionRenderer { constructor(scene, bus); update(dt, night: boolean): void }`:
  - One vehicle group per `VehicleKind`, built from primitive boxes/cylinders in flat-shaded safety colors (cab `#e8641b`, body `#3c3f41`, wheels dark cylinders). Distinct silhouettes: excavator = tracked base + rotating cab + boom arm (boom bobs ±10° at 0.4Hz while working); truck = cab + tipping bed; paver = low slab + hopper; roller = drum cylinder front; liner = small truck + rear nozzle.
  - Vehicles lerp toward event `pos` (damped, λ=10) and rotate to `heading`; only the active stage's vehicle is visible; roller follows the paver at `max(0, t-8)` along the same edge during `paved`.
  - Amber beacon: small sphere, emissive pulsing 2Hz on the active vehicle, brighter when `night`.
  - Dust puffs: small `THREE.Points` burst at the excavator every 0.5s while grading; steam wisps (slow-rising, fading points) behind the paver. Particle pool of 200, no allocation per frame.
  - Vehicles fade out (scale-down 0.4s easeOutCubic) when a job completes, fade in at next job start.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Visual verification** — draw a long road: excavator crawls with dust and terrain visibly flattening under it, truck pass leaves gravel, paver+trailing roller lay dark asphalt with steam, liner paints dashes. Screenshot at each stage.
- [ ] **Step 3: Commit** — `git commit -am "feat: construction crew vehicles with work effects"`

---

### Task 11: Lane graph + A* routing (sim only)

**Files:**
- Create: `src/sim/roads/lanes.ts`
- Test: `tests/lanes.test.ts`

**Interfaces:**
- Consumes: `RoadGraph` (edges with `stage === 'painted'` only), `sampleAt`.
- Produces:
  - `interface Lane { id: number; edgeId: number; from: number; to: number; points: V3[]; length: number; maxSpeed: number[] }` — `points` are edge samples offset `LANE_OFFSET` to the RIGHT of travel direction (perpendicular in XZ); `maxSpeed[i]` from local curvature: `min(9, 2.2 / (curvature + 0.02))` where curvature = heading change per unit length over a 3-sample window.
  - `buildLaneGraph(graph: RoadGraph): LaneGraph` where `LaneGraph = { lanes: Map<number, Lane>; outgoing: Map<number, number[]> }` (`outgoing` keyed by node id → lane ids starting there). Two lanes per painted edge (a→b and b→a).
  - `findRoute(lg: LaneGraph, fromNode: number, toNode: number): Lane[] | null` — A* over lanes (successor = lanes starting at `lane.to`, excluding the reverse lane of the same edge unless it is the only option); heuristic = euclidean node distance; cost = lane length.

- [ ] **Step 1: Write failing tests**

`tests/lanes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildLaneGraph, findRoute } from '../src/sim/roads/lanes';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import type { P2, RoadSample } from '../src/core/types';

const flatSampler = (ctrl: P2[]): RoadSample[] => {
  // densify straight segments at 2u so offsets are smooth
  const out: RoadSample[] = [];
  for (let s = 0; s < ctrl.length - 1; s++) {
    const a = ctrl[s], b = ctrl[s + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + (b.x - a.x) * k / n, y: 0, z: a.z + (b.z - a.z) * k / n, bridge: false });
  }
  out.push({ x: ctrl[ctrl.length - 1].x, y: 0, z: ctrl[ctrl.length - 1].z, bridge: false });
  return out;
};

function grid(): RoadGraph {
  const g = new RoadGraph(new EventBus(), flatSampler);
  g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
  g.commitChain([{ x: 64, z: 0 }, { x: 64, z: 64 }]);
  g.commitChain([{ x: 0, z: 0 }, { x: 0, z: 64 }, { x: 64, z: 64 }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  return g;
}

describe('lane graph', () => {
  it('creates two directed lanes per painted edge, offset to the right', () => {
    const g = new RoadGraph(new EventBus(), flatSampler);
    g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    for (const e of g.edges.values()) e.stage = 'painted';
    const lg = buildLaneGraph(g);
    expect(lg.lanes.size).toBe(2);
    const eastbound = [...lg.lanes.values()].find((l) => l.points[0].x < 32)!;
    expect(eastbound.points[1].z).toBeGreaterThan(0.5); // +x travel, right side is +z
  });
  it('ignores unpainted edges', () => {
    const g = new RoadGraph(new EventBus(), flatSampler);
    g.commitChain([{ x: 0, z: 0 }, { x: 64, z: 0 }]);
    expect(buildLaneGraph(g).lanes.size).toBe(0);
  });
  it('A* finds a route across the grid and prefers the short leg', () => {
    const g = grid();
    const lg = buildLaneGraph(g);
    const a = [...g.nodes.values()].find((n) => n.x === 0 && n.z === 0)!.id;
    const b = [...g.nodes.values()].find((n) => n.x === 64 && n.z === 64)!.id;
    const route = findRoute(lg, a, b)!;
    expect(route).not.toBeNull();
    expect(route[0].from).toBe(a);
    expect(route[route.length - 1].to).toBe(b);
    const total = route.reduce((s, l) => s + l.length, 0);
    expect(total).toBeLessThan(200); // took a 2-edge leg (~128u), not a silly loop
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — right-offset: for sample i with direction d = normalize(next−prev in XZ), right = `(−d.z, d.x)`… verify sign with the test (travel +x ⇒ right should be +z in a Y-up right-handed system viewed from above; flip if test fails). Curvature window over headings; A* with binary-heap-free simple sorted array (networks are small).
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat: directed lane graph with A* routing"`

---

### Task 12: Traffic sim + instanced car rendering

**Files:**
- Create: `src/sim/traffic/traffic.ts`, `src/render/carRenderer.ts`
- Test: `tests/traffic.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `LaneGraph`/`findRoute` (rebuilt on `roads:changed`), `RoadGraph`, `GrowthSim.houses` (Task 13 — until then, spawn between random node pairs), `createRng`, `EventBus`.
- Produces `class TrafficSim`:
  - `constructor(graph: RoadGraph, bus: EventBus, rng: () => number)` — rebuilds its lane graph on `roads:changed`.
  - `targetPopulation: number` (set externally; default 6, Task 13 scales it with houses: `6 + houses`; cap 80).
  - `update(dt): void` — spawn up to target (one per second max) on random distinct node pairs with a valid route; per car: advance `s` along current lane by `speed`; `speed` eases toward `min(lane.maxSpeed at s, gapSpeed)` with accel 3 u/s², decel 6 u/s²; `gapSpeed = 0` if the nearest car ahead on the same lane is closer than 5u, proportional up to 14u. Junction lock: `Map<nodeId, carId>`; a car within 6u of lane end must hold the lock to proceed (else decelerates to stop); lock released once 4u into the next lane. Cars despawn at route end. If the lane graph was rebuilt underneath a car (edge removed), despawn it.
  - `cars: ReadonlyArray<{ id: number; pos: V3; heading: number; speed: number; color: number }>` — colors picked from a fixed palette of 8 muted tones by rng.
- Produces `class CarRenderer { constructor(scene); update(cars, night): void }` — one `THREE.InstancedMesh` (capacity 100) of a merged small car shape (body box 2.4×0.9×1.3 + cabin box), `instanceColor` per car; when `night`, a second InstancedMesh of tiny emissive white quads at headlight positions follows the same transforms.

- [ ] **Step 1: Write failing tests**

`tests/traffic.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TrafficSim } from '../src/sim/traffic/traffic';
import { RoadGraph } from '../src/sim/roads/graph';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import type { P2, RoadSample } from '../src/core/types';

const flatSampler = (ctrl: P2[]): RoadSample[] => {
  const out: RoadSample[] = [];
  for (let s = 0; s < ctrl.length - 1; s++) {
    const a = ctrl[s], b = ctrl[s + 1];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + (b.x - a.x) * k / n, y: 0, z: a.z + (b.z - a.z) * k / n, bridge: false });
  }
  out.push({ x: ctrl[ctrl.length - 1].x, y: 0, z: ctrl[ctrl.length - 1].z, bridge: false });
  return out;
};

function world() {
  const bus = new EventBus();
  const g = new RoadGraph(bus, flatSampler);
  g.commitChain([{ x: 0, z: 0 }, { x: 200, z: 0 }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  bus.emit('roads:changed', {});
  const sim = new TrafficSim(g, bus, createRng('traffic'));
  return { bus, g, sim };
}

describe('TrafficSim', () => {
  it('spawns cars up to targetPopulation and moves them', () => {
    const { sim } = world();
    sim.targetPopulation = 3;
    for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
    expect(sim.cars.length).toBeGreaterThan(0);
    expect(sim.cars.length).toBeLessThanOrEqual(3);
    for (const c of sim.cars) expect(Number.isFinite(c.pos.x)).toBe(true);
  });
  it('cars never overlap below the hard gap on the same lane', () => {
    const { sim } = world();
    sim.targetPopulation = 6;
    let minGap = Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      sim.update(1 / 60);
      const byLane = new Map<number, number[]>();
      for (const c of sim.cars) {
        const s = sim.laneAndS(c.id);
        if (!s) continue;
        (byLane.get(s.laneId) ?? byLane.set(s.laneId, []).get(s.laneId)!).push(s.s);
      }
      for (const arr of byLane.values()) {
        arr.sort((a, b) => a - b);
        for (let k = 1; k < arr.length; k++) minGap = Math.min(minGap, arr[k] - arr[k - 1]);
      }
    }
    expect(minGap).toBeGreaterThan(2.5);
  });
  it('despawns cars when their road is removed', () => {
    const { sim, g } = world();
    sim.targetPopulation = 3;
    for (let i = 0; i < 60 * 10; i++) sim.update(1 / 60);
    for (const id of [...g.edges.keys()]) g.removeEdge(id);
    sim.update(1 / 60);
    expect(sim.cars.length).toBe(0);
  });
});
```
(Expose `laneAndS(carId): { laneId: number; s: number } | null` on TrafficSim for the spacing test.)

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement sim; run tests to pass.**
- [ ] **Step 4: Implement `carRenderer.ts`; wire both into `main.ts`** (traffic.update in sim step; carRenderer.update in render step). Visual check: draw a loop of roads, wait for painting, cars appear and drive on the right, queue behind each other, stop for cross traffic at junctions.
- [ ] **Step 5: Commit** — `git commit -am "feat: ambient traffic with lane following, spacing, junction locks"`

---

### Task 13: Growth sim + instanced scenery

**Files:**
- Create: `src/sim/growth/growth.ts`, `src/render/sceneryRenderer.ts`
- Test: `tests/growth.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `RoadGraph` (painted edges' samples), `Heightfield` (`isLand`, `slopeAt`, `heightAt`), `createRng`, `EventBus`.
- Produces `class GrowthSim`:
  - `constructor(graph, hf, bus, rng)` — maintains `dev: Float32Array(GRID_SIZE²)` and a per-cell spawn bitmask. Recomputes a distance-to-painted-road field (BFS over cells seeded by cells within `ROAD_WIDTH` of painted samples) on `roads:changed`, throttled to once per 2 sim-seconds.
  - `update(dt): void` — for cells with roadDist ≤ 6 cells (24u): `dev += dt * rate` with `rate = 0.008 * (1 - roadDist/7)`; skip water/steep cells (`slopeAt > 0.5`). Thresholds (spawn once each, at cell center + rng jitter ±1.5u, random rotation): `0.25 → tree` (2–3 spawns), `0.5 → field`, `0.75 → house`, `0.95 → building`. Never spawn within 5u of a road sample (offset the jitter away). Emits `growth:spawn`.
  - `get houseCount(): number` — drives `traffic.targetPopulation = Math.min(80, 6 + houseCount)` (wire in main.ts).
  - `spawned: ReadonlyArray<{ kind; x; z; rot }>` — for save + renderer rebuild on load.
- Produces `class SceneryRenderer { constructor(scene, hf, bus); update(dt): void; rebuild(spawned): void }`:
  - Four InstancedMeshes (capacity 4000 trees / 600 fields / 800 houses / 300 buildings): tree = cone `#4e7d4a` on stub trunk; field = flat quad 10×10, two-tone green stripes via a second thin quad; house = box 4×3×4 `#d8d5cd` + pyramid roof `#a0522d` with emissive window quad (night); building = box 5×10×5 with emissive window grid (night).
  - Pop-in: new spawns animate scale 0→1 over 0.8s with `easeOutBack`. Houses/buildings sit on `hf.heightAt` and flatten a small pad (call `hf.flattenCircle(x, z, heightAt(x,z), 5)` once at spawn).
  - Listens to `atmosphere:phase` to toggle window emissive intensity (0 day / 1.4 night).

- [ ] **Step 1: Write failing tests**

`tests/growth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { GrowthSim } from '../src/sim/growth/growth';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { makeSampler } from '../src/sim/roads/path';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';

function world() {
  const bus = new EventBus();
  const hf = new Heightfield('grow-test', bus);
  const g = new RoadGraph(bus, makeSampler(hf));
  let anchor = { x: 0, z: 0 };
  outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
    if (hf.isLand(x, z) && hf.isLand(x + 64, z)) { anchor = { x, z }; break outer; }
  g.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
  for (const e of g.edges.values()) e.stage = 'painted';
  const sim = new GrowthSim(g, hf, bus, createRng('grow'));
  bus.emit('roads:changed', {});
  return { bus, sim };
}

describe('GrowthSim', () => {
  it('spawns trees first, then houses, near painted roads', () => {
    const { bus, sim } = world();
    const kinds: string[] = [];
    bus.on('growth:spawn', (e) => kinds.push(e.kind));
    for (let i = 0; i < 60 * 300; i++) sim.update(1 / 60); // 5 sim-minutes
    expect(kinds.filter((k) => k === 'tree').length).toBeGreaterThan(0);
    const firstTree = kinds.indexOf('tree'), firstHouse = kinds.indexOf('house');
    if (firstHouse !== -1) expect(firstTree).toBeLessThan(firstHouse);
    expect(sim.houseCount).toBe(kinds.filter((k) => k === 'house').length);
  });
  it('spawns nothing with no painted roads', () => {
    const bus = new EventBus();
    const hf = new Heightfield('grow-test-2', bus);
    const g = new RoadGraph(bus, makeSampler(hf));
    const sim = new GrowthSim(g, hf, bus, createRng('grow'));
    let n = 0;
    bus.on('growth:spawn', () => n++);
    for (let i = 0; i < 60 * 60; i++) sim.update(1 / 60);
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement sim; tests pass. Implement renderer; wire main.ts** (growth in sim step; `traffic.targetPopulation` updated from `houseCount` each second).
- [ ] **Step 4: Visual verification** — build a few roads, speed up time (temporarily set `loop.timeScale = 8` in console): trees pop in near roads with a soft bounce, then fields, houses (with flattened pads), buildings; traffic thickens as houses appear. Screenshot.
- [ ] **Step 5: Commit** — `git commit -am "feat: development growth sim with instanced scenery"`

---

### Task 14: Atmosphere — day/night, clouds, rain

**Files:**
- Create: `src/render/atmosphere.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: scene handles from `createScene` (sun, hemi, scene fog/background), `EventBus`, `createRng`, `DAY_LENGTH`.
- Produces `class Atmosphere`:
  - `constructor(scene, sun, hemi, bus, rng)`; `timeOfDay: number` (0..1, start 0.35 ≈ mid-morning); `update(dt): void` advances `timeOfDay += dt / DAY_LENGTH`.
  - Sun orbits: elevation `sin(2π(timeOfDay − 0.25))`, azimuth slow drift; keyframed stops (linear-interpolated by timeOfDay) for: sky/background color (`#0e1220` night → `#f5a35c` dawn → `#bfd9e8` day → `#e07a3f` dusk), fog color (matched to sky), sun color/intensity (0 at night → 1.6 warm at noon), hemisphere intensity (0.15 → 0.55).
  - Emits `atmosphere:phase { night }` when sun elevation crosses ±0.02 (hysteresis).
  - Clouds: 9 cloud groups (3–5 merged stretched icosahedra each, `MeshStandardMaterial` white, transparent 0.85, flatShading) at y 60–80, drifting +x at 1.5 u/s, wrapping at world bounds; positions from rng.
  - Rain: scheduler — every rng-interval 90–240s, 40% chance of a 30–60s shower: `THREE.Points` (1500 points) of vertical streaks falling 60 u/s within an 80u radius around the camera target, recycled at ground; during rain, sun intensity ×0.5 and fog densified 1.5×, both eased over 5s in/out.
  - Exposure ease: `renderer.toneMappingExposure` 1.0 day, 0.65 night, eased.

- [ ] **Step 1: Implement + wire** (`atmosphere.update` in render step; pass `night` flag to construction/car/scenery renderers from the `atmosphere:phase` event).
- [ ] **Step 2: Visual verification** — set `DAY_LENGTH` low via console patch or wait: sunset warms the scene, night darkens with lit windows/headlights/beacons, dawn returns; clouds drift; a rain shower eventually passes. Screenshots at day/dusk/night/rain.
- [ ] **Step 3: Commit** — `git commit -am "feat: day/night atmosphere with clouds and rain"`

---

### Task 15: HUD, save/load, screenshot, new world

**Files:**
- Create: `src/ui/hud.ts`, `src/sim/save.ts`
- Test: `tests/save.test.ts`
- Modify: `src/main.ts`, `index.html` (HUD styles per Global Constraints aesthetic)

**Interfaces:**
- Consumes: everything wired in `main.ts`.
- Produces `src/sim/save.ts`:
  - `interface SaveV1 { version: 1; seed: string; timeOfDay: number; edges: { ctrl: P2[]; stage: Stage }[]; growth: { dev: number[]; spawned: { kind: string; x: number; z: number; rot: number }[] } }`
  - `serialize(world: { seed; timeOfDay; graph; growth }): string` and `deserialize(json: string): SaveV1 | null` (null on parse error/version mismatch — caller starts fresh).
  - Restore procedure (implemented as `restoreWorld(save, deps)` in save.ts): rebuild Heightfield from seed → commitChain each edge's ctrl (then force its stage; for stages ≥ `graded`, immediately flatten terrain along non-bridge samples) → set growth dev array + replay spawned list → emit `roads:changed`.
- Produces `class Hud`:
  - Bottom-center toolbar (pointer-events enabled): DRAW / DEMOLISH toggle buttons (sets `drawTool.mode`; active button gets orange underline), time-speed segmented control `1× / 4× / 16×` (sets `loop.timeScale`), NEW WORLD (inline confirm: text input prefilled with a random 2-word seed like `amber-valley` + BUILD button → wipes save, reloads with `?seed=`), PHOTO (renders one frame then `canvas.toBlob` → download `groundwork-<seed>.png`), MUTE (Task 16 wires it).
  - Top-left: seed name + a one-line status ticker (`SURVEYING… / GRADING EARTHWORKS… / LAYING GRAVEL… / PAVING… / PAINTING LINES… / CREW IDLE`) driven by `construction:stage`/`progress` events, uppercase, letter-spaced.
  - First-visit hint (fades after first successful road): "DRAG TO SURVEY A ROAD".
  - Autosave every 10s (`localStorage['groundwork-save']`) and on `visibilitychange`; load on boot; `?seed=` URL param overrides save.

- [ ] **Step 1: Write failing save tests**

`tests/save.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { serialize, deserialize, restoreWorld } from '../src/sim/save';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { RoadGraph } from '../src/sim/roads/graph';
import { makeSampler } from '../src/sim/roads/path';
import { GrowthSim } from '../src/sim/growth/growth';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';

function freshWorld(seed: string) {
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const growth = new GrowthSim(graph, hf, bus, createRng(seed));
  return { bus, hf, graph, growth };
}

describe('save/load', () => {
  it('round-trips edges, stages, and timeOfDay', () => {
    const w = freshWorld('save-test');
    let anchor = { x: 0, z: 0 };
    outer: for (let x = -160; x <= 160; x += 8) for (let z = -160; z <= 160; z += 8)
      if (w.hf.isLand(x, z) && w.hf.isLand(x + 32, z)) { anchor = { x, z }; break outer; }
    const [id] = w.graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
    w.graph.edges.get(id)!.stage = 'painted';
    const json = serialize({ seed: 'save-test', timeOfDay: 0.7, graph: w.graph, growth: w.growth });
    const save = deserialize(json)!;
    expect(save.version).toBe(1);
    const w2 = freshWorld('save-test');
    restoreWorld(save, w2);
    expect(w2.graph.edges.size).toBe(1);
    expect([...w2.graph.edges.values()][0].stage).toBe('painted');
    expect(save.timeOfDay).toBeCloseTo(0.7);
  });
  it('returns null for garbage or wrong version', () => {
    expect(deserialize('not json')).toBeNull();
    expect(deserialize(JSON.stringify({ version: 99 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run FAIL → implement save.ts → run PASS.**
- [ ] **Step 3: Implement HUD + wire autosave/boot-load/seed param.** Styling per the Global Constraints aesthetic — no default-looking buttons: 1px `#3a3d40` borders, charcoal fills, mono uppercase 11px letter-spaced labels, orange active accents.
- [ ] **Step 4: Visual verification** — build roads, reload page: world restores (roads at correct stages, scenery back, terrain graded). New World with a typed seed produces a different island. PHOTO downloads a PNG. Time-speed visibly accelerates crews/growth/day-cycle.
- [ ] **Step 5: Commit** — `git commit -am "feat: hud, versioned save/load, screenshot, new-world flow"`

---

### Task 16: Generative ambient audio

**Files:**
- Create: `src/audio/ambient.ts`
- Modify: `src/main.ts`, `src/ui/hud.ts` (MUTE button wiring)

**Interfaces:**
- Consumes: `EventBus` (`atmosphere:phase`, `construction:stage`, `construction:progress`), timeOfDay getter.
- Produces `class AmbientAudio`:
  - `start(): void` — call on first user pointerdown (autoplay policy); builds `AudioContext`, master `GainNode` (0.5), buses: `music` (0.4), `sfx` (0.6).
  - `muted: boolean` accessor (ramps master gain to 0/0.5 over 0.3s).
  - Pad: two detuned triangle oscillators + one sine an octave below → lowpass (cutoff 400 night / 1400 day, eased 10s) → slow tremolo (gain LFO 0.08Hz ±15%) → music bus. Chord root steps through A-pentatonic minor progression `[A2, C3, D3, E3, G2]`, one change every 24s with 4s crossfade (two voice pairs alternating).
  - Birds (day): every 4–11s, a chirp = 3–5 rapid sine blips 2.2–4.5kHz with random glide, through a bandpass, quiet (−24dB), panned randomly (StereoPannerNode). Crickets (night): pulsed 4.2kHz filtered-noise ticks at 12Hz in 1.5s bursts.
  - Construction: while a job is active, a low filtered-noise engine rumble (−20dB) whose pan follows vehicle x relative to camera (clamped −0.7..0.7); on each `construction:stage`, a soft two-note "task done" marimba blip (sine + short decay envelope). Reverse beeper (880Hz square, 50% duty at 1.2Hz, −26dB) only during `demolish` jobs.
  - `update(dt, timeOfDay, cameraX): void` — eases filters/pans; all scheduling via `ctx.currentTime`, no `setInterval`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Manual verification** — sound starts on first click; pad audibly darkens at night, birds by day, crickets at night; engine rumble + stage blips during construction; beeper during demolition; MUTE ramps cleanly; no clicks/pops on chord changes (check crossfade).
- [ ] **Step 3: Commit** — `git commit -am "feat: generative ambient audio with construction sfx"`

---

### Task 17: Final polish pass, README, deploy

**Files:**
- Create: `README.md`
- Modify: anything the polish checklist below touches

**Interfaces:** none new — this task verifies the spec's polish requirements end-to-end.

- [ ] **Step 1: Polish checklist sweep** (fix anything failing; each item is from the spec):
  - No popping anywhere: road stage transitions, scenery pop-in, vehicle appear/disappear, rain/exposure/fog transitions all eased.
  - Draw feel: snap is magnetic, stakes have dust puffs on plant (reuse construction dust pool), invalid = red tint fade, hover ring breathes.
  - Camera: damped everywhere; idle 20s → cinematic slow orbit; input interrupts instantly; gentle exposure shift dawn/dusk works with it.
  - Construction showpiece: dust under excavator, steam behind paver, wet asphalt dries (roughness lerp), roller compaction slightly darkens the gravel ribbon behind it (vertex color tweak), beacons pulse at night.
  - Performance: with ~30 edges, 60+ cars, full scenery — devtools shows ≥ 55fps on this machine; draw calls sane (instancing confirmed via `renderer.info.render.calls` < 150).
- [ ] **Step 2: Full test + build** — `npm test && npm run build` green.
- [ ] **Step 3: README** — what it is, controls (drag/RMB orbit/wheel zoom/toolbar), seed URLs, dev commands, architecture paragraph pointing at the spec + plan docs.
- [ ] **Step 4: Create GitHub repo and deploy**

```bash
gh repo create road-build --public --source . --push
gh api repos/{owner}/road-build/pages -X POST -f build_type=workflow || true
```
Then verify the Actions run goes green and the Pages URL serves the game. Load it in a browser, click around, confirm autosave + audio + drawing all work on the deployed build (Vite `base: './'` should make asset paths relative).

- [ ] **Step 5: Commit + push** — `git add -A && git commit -m "docs: readme + final polish pass" && git push`

---

## Task order & dependencies

```
1 scaffold → 2 core → 3 heightfield → 4 terrain render ┐
                                                        ├→ 5 graph → 6 path → 7 road render → 8 draw tool
                                                        │            → 9 queue → 10 crew render
                                                        │            → 11 lanes → 12 traffic
                                                        │            → 13 growth
4 ───────────────────────────────────────────────────── → 14 atmosphere
8,9,13 ─────────────────────────────────────────────── → 15 hud/save
14 ──────────────────────────────────────────────────── → 16 audio
all ─────────────────────────────────────────────────── → 17 polish/deploy
```
Execute strictly in numeric order — later tasks assume all earlier interfaces exist.

---

# Addendum A — Construction 10x (approved by Sam 2026-07-02, full scope incl. bridge crane)

Post-v1 upgrade of the construction theater. Zen constraints remain binding: no failure states, no player management, everything ambient. Sim/render split remains binding: choreography is render-side, driven by existing events; sim changes are limited to what's listed. Perf: ≥55 fps, draw calls ≤ 220 on a busy world.

### Task 20: Animation fidelity

**Files:** `src/render/constructionRenderer.ts` (major), `src/render/easing.ts` (helpers as needed)
- Excavator: articulated boom/stick/bucket rig with a dig-swing-dump cycle (three pivots, keyframed procedurally; cycle ~4s) replacing the bobbing arm; cab yaw toward dig side.
- All vehicles: wheels/tracks rotate proportional to actual travel speed; body pitch/roll aligns to `hf.slopeAt` under the vehicle (damped); acceleration/deceleration eased (no constant-velocity glide).
- Dump truck: bed tips (rotate ~35° over 1.2s) when depositing; paver visibly extrudes the mat (a short fresh-asphalt quad trailing its rear); roller performs visible back-and-forth passes (±6u oscillation around the work front) with a spinning drum.
- Tire/track marks: instanced fading decals in dirt during graded/gravel stages (pool ≤ 256, fade 20s).
- Night work: one floodlight-tower prop near the work front when `night`, warm SpotLight (single light, budgeted) + emissive head.

### Task 21: Process, logistics & site dressing

**Files:** `src/render/constructionRenderer.ts`, `src/sim/construction/queue.ts` (survey phase only), `src/core/types.ts` (VehicleKind += 'surveyor', 'crane')
- Sim: new initial survey work phase on build jobs (vehicle `surveyor`, 20 u/s, runs before graded work; no stage transition — edges are already born 'surveyed'; demolish and resume-from->surveyed skip it). Progress events carry `vehicle: 'surveyor'`.
- Surveyor unit: small figure + tripod prop; plants survey stakes sequentially as it passes (stakes already exist as preview — now real ones appear during the phase, removed when grading passes).
- Truck shuttle: during graded, truck follows excavator, receives spoil (bucket dumps into bed on each dig cycle), drives off-site along the built network (or toward map edge) when full, returns empty — purely cosmetic timing, sim progress unchanged. During paved, truck docks at the paver hopper and tips gradually.
- Arrivals/departures: crew vehicles drive to the job's start along existing painted roads when possible (reuse lane paths), else overland in a straight damped path; drive away on completion. Replaces fade-in/out (fades remain only as fallback for offscreen spawn).
- Site dressing: instanced traffic cones bracketing the active work front (±10u), small material stockpile prop (gravel mound + pallet) at the job start, all removed with a fade when the job completes.

### Task 22: Bridge construction theater

**Files:** `src/render/constructionRenderer.ts`, `src/render/roadRenderer.ts`
- Pylons rise: scale-Y 0→1 with easeOutCubic as the work front passes their station during graded work (roadRenderer exposes per-edge bridge-run metadata for the choreography; today pylons appear with the stage rebuild).
- Crane: new vehicle rig (lattice boom + hook) stationed at the bridge run during gravel-stage work across bridge samples; deck segments (16u) lower-and-settle sequentially from the hook as the work front crosses each; ribbon over bridge runs is masked until its segment settles (coordinate with roadRenderer's partial-progress split so there is never a visible gap behind the settled segment).
- Rails appear with a quick settle after each span; existing bridge geometry/disposal rules unchanged.

Each task: implementer → review gate → fix loop, as before. Visual verification with screenshots is mandatory; regression tests where sim is touched (survey phase: queue tests for phase ordering and resume/demolish skip).

---

# Addendum B — Construction 10x round 2 (approved by Sam 2026-07-03: parallel crews + richer realism)

Zen constraints and sim/render split remain binding. Perf: ≥55 fps, draw calls ≤ 250.

### Task 25: Multi-crew construction

**Files:** `src/sim/construction/queue.ts` (+tests), `src/core/events.ts` (additive field), `src/render/constructionRenderer.ts`, `src/ui/hud.ts`
- Sim: `BuildQueue` runs up to `MAX_CREWS = 3` concurrent jobs (one per crew slot). FIFO assignment to free crews; demolish jobs take the next free crew (or convert their edge's active job in place, as today). `construction:progress`/`construction:stage` gain an additive `crew: number` field (0-based). All existing single-crew semantics per job unchanged (survey phase, stage speeds, grading, resume, demolish conversion).
- TDD: two queued edges build CONCURRENTLY (both advance in the same update window); three-plus queue drains as crews free; per-crew event attribution correct; save/restore resumes across multiple crews; demolish-jumps-queue still holds.
- Render: per-crew rig sets (3× the vehicle roster, built once, hidden when crew idle — instancing not required, rigs are cheap primitives; verify draw-call budget). Site dressing (cones/stockpile/floodlight) per active crew. Vehicle state maps keyed by (crew, kind).
- HUD ticker: show up to 3 crew lines (CREW 1 PAVING… / CREW 2 GRADING…), collapse when idle.

### Task 26: Richer site realism

**Files:** `src/render/constructionRenderer.ts` (mostly), `src/audio/ambient.ts` (light touches)
- Worker figures (≤6 prims each, 2-3 per active crew): a flagger near the cones (slow wave cycle), a spotter walking alongside the active vehicle, a worker with shovel idling by the stockpile. Simple bone-less bob/step animation; fade with the crew.
- Equipment variety: motor grader (blade) joins the gravel stage trailing the truck's drops and leveling them (visual only); plate-compactor prop near fresh paint.
- Exhaust: small dark puff particles from vehicle stacks while working (existing pool mechanism).
- Material logistics dressing: stockpile visibly depletes as stages consume it; paint stencil frame around the liner's nozzle; wet-sheen on fresh center dashes (mirror the fresh-asphalt roughness lerp).
- Audio: soft radio-chatter blips (filtered noise bursts, −30dB) occasionally from the active crew; shovel/scrape one-shot tied to grader passes. Keep all of it subtle.
- Everything eases; crew fade rules apply to workers/props.

---

# Addendum C — Cones, graphics 10x, mobile (approved by Sam 2026-07-03)

Zen constraints + sim/render split binding. Perf targets now TIERED: desktop ≥55fps with full effects; mobile ≥30fps at reduced tier.

### Task 27: Static work-zone cones

`src/render/constructionRenderer.ts` only. Cones no longer track the moving work front. New behavior: when a crew's job starts, cones fade in at FIXED positions along the job's road segment — pairs flanking the roadway (offset ±(ROAD_WIDTH/2 + 0.8)) every ~14u along the full edge, plus one pair at each end — and remain exactly where placed for the whole job. They fade out with the crew's dressing at completion/removal. Instanced pool sized for the longest edge (cap ~48/crew; if an edge needs more, space them wider). Demolition jobs get the same treatment.

### Task 28: Graphics 10x (tiered)

Files: `src/render/scene.ts`, new `src/render/postfx.ts`, `src/render/terrainRenderer.ts` (water), `src/render/atmosphere.ts`, touched materials.
- **Post pipeline (desktop tier)**: EffectComposer — subtle bloom (UnrealBloomPass, threshold ~0.85, strength ~0.35 — night lights/beacons/windows bloom, day stays clean) + gentle vignette. SSAO optional: include ONLY if frame budget holds on this machine (report numbers); otherwise document skip.
- **Sky**: gradient sky dome (custom shader: horizon→zenith blend driven by the atmosphere's keyframe colors) with a visible sun disc + glow; STARS at night (point sprites fading in below sun elevation −0.05); moon optional.
- **Water**: animated — gentle normal-perturbation ripples (time-based shader noise on the water material via onBeforeCompile or a ShaderMaterial), subtle shore foam band where depth ≈ 0 (distance-to-shore approximation via terrain height lookup baked to a texture or vertex attribute), slightly deeper color gradient by depth.
- **Shadows**: PCFSoftShadowMap, tuned bias/normalBias (no acne, no peter-panning), shadow camera tightened to the island.
- **Terrain**: subtle macro-variation (low-frequency shader noise multiplying vertex colors ±6%) to break up flat fields; keep the low-poly look — this is seasoning, not texturing.
- **Quality tiers**: `RenderQuality = 'high' | 'low'` module — high: all of the above, devicePixelRatio ≤2, 2048 shadows; low: no composer (direct render), 1024 shadows, pixelRatio ≤1.5, water ripples simplified, stars capped. Auto-detect (mobile UA/GPU heuristic) + `?quality=` override. Atmosphere/day-night must look correct in BOTH tiers.

### Task 29: Mobile support

Files: `src/input/*`, `src/ui/hud.ts`, `index.html`, `src/main.ts`.
- Touch input: one-finger drag = draw (in DRAW mode) / tap = demolish (in DEMOLISH mode); two-finger = pan (drag) + pinch (zoom) + twist (orbit); inertia damped like mouse. Pointer events already used — extend to multi-touch gesture recognition in cameraRig; DrawTool ignores multi-touch.
- HUD: responsive layout ≤480px (toolbar wraps/compacts, larger touch targets ≥44px, seed/ticker scale down); `viewport` meta (no user scaling); no hover-dependent affordances (hover ring appears under the finger during draw).
- Perf: mobile auto-selects 'low' tier (Task 28); cap sim step count on weak devices unchanged (already capped); verify on this machine via responsive emulation (375×812) — touch drawing, pinch, HUD usability, and playable fps in the emulated profile (real-device numbers are a user follow-up).
- iOS quirks: audio unlock on first touchend (not just pointerdown); prevent double-tap zoom on the canvas; safe-area insets for the toolbar.

---

# Addendum D — Living-world & construction-flow improvements (approved by Sam 2026-07-03, full audit list + fading demolished areas)

Executes after Addendum C (T27-29). Zen + sim/render split + tiered perf targets binding. Save compatibility: any task that changes the save shape bumps the version with a migration (older saves must load).

### Task 30: Settlement placement intelligence (growth)

`src/sim/growth/growth.ts` (+tests), `src/render/sceneryRenderer.ts` (only if needed).
- Houses/buildings spawn FACING the nearest road: rotation = heading perpendicular toward the road sample (±0.15 rad jitter), not random.
- Setback band: houses/buildings place at a consistent 8-10u from the road centerline (project spawn point onto the clearance band along the perpendicular from the nearest sample), replacing the radial push. Keep the ≥6.5u hard clearance.
- Fields align to the road direction (rot = road heading ±0.1) and prefer cells adjacent to an existing house (scan the records within ~14u; if none, current behavior) — farmsteads.
- Trees keep random rotation (correct for trees).
- TDD: rotation-faces-road assertion (angle between building forward and direction-to-road < 0.35 rad); setback distance within [6.5, 11]; field-near-house preference (deterministic seed).

### Task 31: Ambient wilderness

`src/sim/growth/growth.ts` or new `src/sim/growth/wilderness.ts`, `src/render/sceneryRenderer.ts`, `src/main.ts`.
- At worldgen: sparse seeded trees across the island (Poisson-ish via seeded rng + spacing ≥10u, land-only, slope ≤ 0.5, density ~1 per 250 u² → several hundred), 1-3 per site, NOT saved (regenerated deterministically from seed on boot — document in save.ts that wilderness is derived state).
- Rendered through the existing tree instancing (raise capacity if needed; report instance counts + draw calls). No pop-in at boot (instant), normal pop-in never applies.
- Road construction may overlap wilderness trees: clear trees within the road corridor +2u when an edge reaches graded (fade-out) — the excavator "clears" them. Deterministic given same build order.

### Task 32: Traffic between settlements

`src/sim/traffic/traffic.ts` (+tests), reading `GrowthSim.spawned` (or an exposed settlement-node index).
- Trip endpoints weighted toward nodes near houses/buildings: build a weight map (node weight = 1 + 3×houses-within-20u + 5×buildings-within-20u, recomputed on growth spawns throttled); pick origin/destination by weighted draw (fallback: uniform when no settlement yet).
- Commute pulse: spawn-interval scales with timeOfDay — busiest at ~0.3 and ~0.75 (morning/evening), ~40% rate at deep night. Atmosphere's timeOfDay is render-side — pass timeOfDay into traffic.update from main (sim stays deterministic given inputs).
- TDD: weighted-draw distribution sanity (seeded), night-rate reduction, no-settlement fallback.

### Task 33: Crew assignment + work rhythm (construction)

`src/sim/construction/queue.ts` (+tests), `src/render/constructionRenderer.ts` (break theater).
- Nearest-crew assignment: when multiple crews are free, a new job goes to the free crew whose LAST job site (persisted per crew; map-center default) is nearest to the new edge's start. FIFO order among jobs preserved; only crew choice changes. TDD: nearest-free-crew chosen; ties → lowest index.
- Work rhythm: every 3-5 sim-minutes per crew, a 6s break (job progress pauses, `construction:progress` keeps firing with stationary pos so renderers can react); workers huddle near the stockpile, vehicles idle (no dig cycle). Night: stage speeds ×0.85 (floodlit crews work a bit slower). TDD: break pauses t-advance then resumes; night multiplier applied.

### Task 34: Quarry landmark

`src/sim/` (placement + save), `src/render/constructionRenderer.ts` (shuttle routing + prop).
- One quarry per island: placed when the FIRST road commits — nearest suitable flat coastal-adjacent cell ≥40u from that road (seeded deterministic search); saved in the save file (version bump if shape changes).
- Prop: gravel pit + conveyor + silo (≤14 prims, instanced not needed — one instance).
- All shuttle trips (spoil away, gravel fetch) route to the quarry instead of "toward map edge / fade at distance"; if the quarry is far, trucks still fade mid-route after ~12s but HEAD toward it (theater budget unchanged).

### Task 35: Settlement dynamics — upgrades + stranded decay

`src/sim/growth/growth.ts` (+tests), `src/render/sceneryRenderer.ts`, `src/sim/save.ts` (VERSION BUMP + migration), `src/core/events.ts` (additive `growth:remove` + `growth:upgrade` events).
- Spawned records gain stable `id`s (migration assigns ids to old saves).
- Upgrades: when a cell's dev ≥ 1.35 AND ≥2 developed neighbors, an existing house record upgrades to building (event `growth:upgrade {id}`; renderer swaps with pop animation; houseCount−1, buildings implicitly count via records).
- **Stranded decay (user-decided)**: after roads:changed recompute, records >24u from any painted road enter a 60 sim-s grace period; if still stranded, fade out over ~30s (renderer eases scale down + slight sink), then `growth:remove {id}` deletes the record and CLEARS the cell's spawnMask bits (so re-roading the area regrows it). houseCount decrements on house removal. Traffic weight map reacts via its existing throttle.
- TDD: upgrade conditions; decay grace + removal + mask clearing + houseCount; save round-trip v2 + v1-migration test.

### Task 36: Pipelined stage train (construction — LAST, riskiest)

`src/sim/construction/queue.ts` (+substantial tests), `src/render/roadRenderer.ts` (multi-band), `src/render/constructionRenderer.ts`.
- A job runs up to all 4 work stages CONCURRENTLY as fronts along the edge: front(stage i) may advance only while ≥30u behind front(stage i−1) (or stage i−1 complete); survey remains a discrete first pass. Stage completion event fires when that stage's front reaches edge end (order preserved: graded completes before gravel completes, etc.). `construction:progress` fires per active front (multiple per tick per crew, distinct `vehicle`).
- RoadRenderer: partial-progress rendering generalizes from one boundary to up to 4 bands (painted..paved..gravel..graded..surveyed along arclength) — reuse the existing from/to ribbon builder per band; throttling unchanged.
- ConstructionRenderer: multiple vehicles per crew active simultaneously (state maps already keyed (crew,kind) — verify shuttle/roller interplay), convoy spacing reads naturally.
- Grading terrain work unchanged (tied to the graded front). Demolition stays sequential (reverse train optional — out of scope).
- TDD: spacing constraint enforced; completion order; resume mid-train from save (resume collapses to sequential from the saved stage — acceptable, document); demolish conversion mid-train.

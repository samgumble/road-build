# Living Weather Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace binary rain scheduling with a persisted, smoothly blended clear/overcast/rain/fog system that enriches visuals without changing simulation outcomes.

**Architecture:** A pure seeded `WeatherController` owns state selection, dwell, transitions, snapshots, and save state. `Atmosphere` applies the snapshot to sky/cloud/rain/fog/light; road, water, scenery, and Guide consume the same snapshot through explicit render-only inputs.

**Tech Stack:** TypeScript, Three.js shaders/materials, Vitest, existing Atmosphere/Sky/TerrainRenderer/SceneryRenderer/HUD, Save V4 weather reservation from the junction-controls plan.

## Global Constraints

- Weather kinds: clear, overcast, light rain, heavy rain, coastal fog.
- Transitions last 8–15 sim seconds; direct clear→heavy-rain is forbidden.
- Weather is presentation-only and has no input path into traffic, construction, growth, routing, or physics.
- Fog near is never below 35u; fog far is never below 110u.
- Clear weather preserves current dry road/water values plus baseline day/night fog and lighting;
  cloud coverage may become sparser than the current always-cloudy presentation.
- One blended snapshot drives all consumers; consumers do not schedule weather independently.
- Restore resumes current/next state, transition progress, dwell remaining, and transition index.
- High and low quality use the same state machine; low quality keeps its cheaper mesh/postfx path.

## File map

- `src/core/weather.ts`: kinds, save state, snapshot/profile types and defaults.
- `src/render/weather.ts`: pure seeded controller and deterministic transition graph.
- `src/render/atmosphere.ts`: replaces rain scheduler; applies snapshot to clouds/rain/fog/lights/exposure.
- `src/render/terrainRenderer.ts`: weather-driven water ripple/roughness response.
- `src/render/sceneryRenderer.ts`: shared shader uniforms for tree sway and field ripple.
- `src/render/roadRenderer.ts`: continues consuming the snapshot's `rain` scalar.
- `src/core/events.ts`: additive completed-weather-transition event.
- `src/ui/hud.ts`: Guide weather line.
- `src/main.ts`: controller construction, restore/save, and render-only wiring.
- `tests/weather.test.ts`, `tests/atmosphere.test.ts`, `tests/roadWeather.test.ts`, `tests/hud.test.ts`, `tests/save.test.ts`: coverage.

---

### Task 1: Pure seeded weather controller

**Files:**
- Modify: `src/core/weather.ts`
- Create: `src/render/weather.ts`
- Create: `tests/weather.test.ts`

**Interfaces:**
- Produces:

```ts
export const WEATHER_KINDS = ['clear', 'overcast', 'light-rain', 'heavy-rain', 'coastal-fog'] as const;
export type WeatherKind = typeof WEATHER_KINDS[number];
export interface WeatherSnapshot {
  kind: WeatherKind; cloudCover: number; cloudDarkness: number;
  rain: number; fog: number; wind: number; waterRoughness: number;
}
export class WeatherController {
  constructor(seed: string, initial?: WeatherSaveState);
  update(dt: number): boolean; // true only when a transition completes
  get snapshot(): Readonly<WeatherSnapshot>;
  get saved(): WeatherSaveState;
  restore(state: WeatherSaveState): void;
}
export const WEATHER_PROFILES: Readonly<Record<WeatherKind, WeatherSnapshot>>;
```

- [x] **Step 1: Write failing deterministic/state-machine tests**

```ts
it('produces the same state sequence for the same seed and dt sequence', () => {
  const a = new WeatherController('weather-seed');
  const b = new WeatherController('weather-seed');
  const seqA: WeatherKind[] = [];
  const seqB: WeatherKind[] = [];
  for (let i = 0; i < 1800; i++) {
    if (a.update(1)) seqA.push(a.snapshot.kind);
    if (b.update(1)) seqB.push(b.snapshot.kind);
  }
  expect(seqA).toEqual(seqB);
  expect(seqA.length).toBeGreaterThan(4);
});

it('never transitions directly from clear to heavy rain', () => {
  const weather = new WeatherController('transition-graph');
  let previous = weather.snapshot.kind;
  for (let i = 0; i < 10000; i++) {
    if (!weather.update(1)) continue;
    const current = weather.snapshot.kind;
    expect([previous, current]).not.toEqual(['clear', 'heavy-rain']);
    previous = current;
  }
});

it('blends every snapshot field continuously and within 0..1', () => {
  const weather = new WeatherController('blend', {
    current: 'overcast', next: 'light-rain', transition: 0, remaining: 0, transitionIndex: 3,
  });
  const samples = Array.from({ length: 9 }, () => {
    weather.update(1);
    return { ...weather.snapshot };
  });
  for (const sample of samples) {
    for (const key of ['cloudCover', 'cloudDarkness', 'rain', 'fog', 'wind', 'waterRoughness'] as const) {
      expect(sample[key]).toBeGreaterThanOrEqual(0);
      expect(sample[key]).toBeLessThanOrEqual(1);
    }
  }
  expect(samples[0].rain).toBeLessThan(samples[samples.length - 1].rain);
});

it('restores mid-transition and chooses the same following state', () => {
  const original = new WeatherController('restore-weather');
  for (let i = 0; i < 175; i++) original.update(1);
  const restored = new WeatherController('restore-weather', original.saved);
  for (let i = 0; i < 300; i++) {
    original.update(1);
    restored.update(1);
  }
  expect(restored.saved).toEqual(original.saved);
  expect(restored.snapshot).toEqual(original.snapshot);
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/weather.test.ts`

Expected: `src/render/weather.ts` missing.

- [x] **Step 3: Define profiles, transition graph, and deterministic draws**

Use exact profiles:

```ts
export const WEATHER_PROFILES: Record<WeatherKind, WeatherSnapshot> = {
  clear:         { kind: 'clear', cloudCover: .22, cloudDarkness: 0,   rain: 0,   fog: 0,   wind: .18, waterRoughness: .12 },
  overcast:      { kind: 'overcast', cloudCover: .82, cloudDarkness: .45, rain: 0, fog: .22, wind: .38, waterRoughness: .34 },
  'light-rain':  { kind: 'light-rain', cloudCover: .92, cloudDarkness: .58, rain: .5, fog: .38, wind: .55, waterRoughness: .55 },
  'heavy-rain':  { kind: 'heavy-rain', cloudCover: 1, cloudDarkness: .82, rain: 1, fog: .62, wind: .88, waterRoughness: .82 },
  'coastal-fog': { kind: 'coastal-fog', cloudCover: .55, cloudDarkness: .18, rain: 0, fog: 1, wind: .12, waterRoughness: .2 },
};

const NEXT: Record<WeatherKind, WeatherKind[]> = {
  clear: ['overcast', 'coastal-fog'],
  overcast: ['clear', 'light-rain', 'coastal-fog'],
  'light-rain': ['overcast', 'heavy-rain'],
  'heavy-rain': ['light-rain', 'overcast'],
  'coastal-fog': ['clear', 'overcast'],
};
```

For transition index `i`, create `createRng(`${seed}:weather:${i}`)`. First draw selects next kind;
second selects transition duration `8 + rng()*7`; third selects state dwell from:

```ts
const DWELL: Record<WeatherKind, [number, number]> = {
  clear: [120, 240], overcast: [90, 180], 'light-rain': [60, 120],
  'heavy-rain': [45, 90], 'coastal-fog': [60, 150],
};
```

Re-derive transition duration from seed/index after restore. Blend with smoothstep
`u*u*(3-2*u)`. During transition, `snapshot.kind` remains `current`; it changes to `next` only when
the transition completes and `update` returns true.

- [x] **Step 4: Run controller tests**

Run: `npx vitest run tests/weather.test.ts`

Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/core/weather.ts src/render/weather.ts tests/weather.test.ts
git commit -m "feat(weather): add seeded living weather state machine"
```

---

### Task 2: Atmosphere cloud, rain, fog, and light integration

**Files:**
- Modify: `src/render/atmosphere.ts`
- Modify: `src/core/events.ts`
- Modify: `tests/atmosphere.test.ts`

**Interfaces:**
- `Atmosphere` constructor receives `weather: WeatherController` after `rng`.
- Adds getters `weatherSnapshot` and `weatherSave`.
- Adds event `'atmosphere:weather': { kind: WeatherKind }` on completed transitions only.

- [x] **Step 1: Write failing atmosphere composition tests**

Extract a pure helper:

```ts
export interface WeatherAtmosphereValues {
  fogNear: number; fogFar: number; sunScale: number;
  hemiScale: number; cloudOpacity: number; rainOpacity: number;
}
export function weatherAtmosphereValues(
  snapshot: WeatherSnapshot, baseFogNear: number, baseFogFar: number,
): WeatherAtmosphereValues;
```

Tests:

```ts
it('clamps maximum fog to the gameplay visibility floor', () => {
  const values = weatherAtmosphereValues(WEATHER_PROFILES['coastal-fog'], 80, 320);
  expect(values.fogNear).toBeGreaterThanOrEqual(35);
  expect(values.fogFar).toBeGreaterThanOrEqual(110);
});

it('keeps clear weather identical to existing atmosphere values', () => {
  const values = weatherAtmosphereValues(WEATHER_PROFILES.clear, 80, 320);
  expect(values.fogNear).toBe(80);
  expect(values.fogFar).toBe(320);
  expect(values.sunScale).toBe(1);
  expect(values.hemiScale).toBe(1);
  expect(values.rainOpacity).toBe(0);
});

it('makes fog and heavy rain visually distinct', () => {
  const fog = weatherAtmosphereValues(WEATHER_PROFILES['coastal-fog'], 80, 320);
  const rain = weatherAtmosphereValues(WEATHER_PROFILES['heavy-rain'], 80, 320);
  expect(fog.fogFar).toBeLessThan(rain.fogFar);
  expect(fog.rainOpacity).toBe(0);
  expect(rain.rainOpacity).toBeGreaterThan(0.8);
});
```

- [x] **Step 2: Run atmosphere tests and verify RED**

Run: `npx vitest run tests/atmosphere.test.ts`

Expected: helper absent.

- [x] **Step 3: Replace binary scheduler with snapshot application**

Delete `RAIN_*INTERVAL`, `RAIN_CHANCE`, duration fields, and `updateRainScheduler`. In `update(dt)`,
call `weather.update(dt)` before applying visuals; emit `atmosphere:weather` when it returns true.

Implement composition:

```ts
export function weatherAtmosphereValues(s: WeatherSnapshot, near: number, far: number): WeatherAtmosphereValues {
  return {
    fogNear: Math.max(35, THREE.MathUtils.lerp(near, near / 2.1, s.fog)),
    fogFar: Math.max(110, THREE.MathUtils.lerp(far, far / 2.4, s.fog)),
    sunScale: 1 - 0.55 * Math.max(s.cloudDarkness, s.rain),
    hemiScale: 1 - 0.28 * s.cloudDarkness,
    cloudOpacity: THREE.MathUtils.lerp(0.36, 0.9, s.cloudCover),
    rainOpacity: RAIN_OPACITY * s.rain,
  };
}
```

Keep every cloud mesh allocated and compute per-cloud opacity weight as
`clamp(cloudCover * CLOUD_GROUP_COUNT - i, 0, 1)`, avoiding visibility pops as coverage crosses a
group boundary. Apply color lerp from white to `#6f7780` using `cloudDarkness`; drift speed multiplies
`0.65 + 1.1*wind`. Set rain draw range to `floor(RAIN_COUNT * rain) * 2` vertices and opacity to
the helper value. Existing camera-following streak recycling remains.

Apply fog values, multiply existing day/night sun/hemi values by scales, and reduce exposure by at
most 0.08 under cloud darkness while retaining the current day/night targets.

- [x] **Step 4: Run weather/atmosphere tests**

Run: `npx vitest run tests/weather.test.ts tests/atmosphere.test.ts && npx tsc --noEmit`

Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/render/atmosphere.ts src/core/events.ts tests/atmosphere.test.ts
git commit -m "feat(render): drive atmosphere from blended weather"
```

---

### Task 3: Wet roads and weather-responsive water

**Files:**
- Modify: `src/render/terrainRenderer.ts`
- Modify: `src/main.ts`
- Modify: `tests/roadWeather.test.ts`
- Modify: `tests/weather.test.ts`

**Interfaces:**
- `TerrainRenderer.update(dt, daylight = 1, weather?: WeatherSnapshot)`.
- `RoadRenderer.update` continues receiving only `weather.rain`.

- [x] **Step 1: Write failing water-response tests**

Export a pure helper:

```ts
export function waterWeatherValues(snapshot: WeatherSnapshot): {
  rippleAmpScale: number; rippleSpeedScale: number; foamScale: number;
};
```

Tests:

```ts
it('keeps clear water at authored defaults and strengthens heavy-weather motion', () => {
  expect(waterWeatherValues(WEATHER_PROFILES.clear)).toEqual({
    rippleAmpScale: 1, rippleSpeedScale: 1, foamScale: 1,
  });
  const heavy = waterWeatherValues(WEATHER_PROFILES['heavy-rain']);
  expect(heavy.rippleAmpScale).toBeGreaterThan(1.5);
  expect(heavy.rippleSpeedScale).toBeGreaterThan(1.4);
  expect(heavy.foamScale).toBeGreaterThan(1);
});

it('keeps fog water calm compared with heavy rain', () => {
  expect(waterWeatherValues(WEATHER_PROFILES['coastal-fog']).rippleAmpScale)
    .toBeLessThan(waterWeatherValues(WEATHER_PROFILES['heavy-rain']).rippleAmpScale);
});
```

Retain current `wetRoadAppearance` tests and add a snapshot-driven assertion that clear maps to
rain 0 and heavy rain maps to rain 1.

- [x] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/weather.test.ts tests/roadWeather.test.ts`

Expected: helper/signature absent.

- [x] **Step 3: Add dynamic water uniforms**

Add `uWeatherFoamScale`. Keep base quality constants immutable and set uniforms every frame:

```ts
export function waterWeatherValues(s: WeatherSnapshot) {
  const rough = Math.max(0, (s.waterRoughness - WEATHER_PROFILES.clear.waterRoughness) / (1 - WEATHER_PROFILES.clear.waterRoughness));
  const wind = Math.max(0, (s.wind - WEATHER_PROFILES.clear.wind) / (1 - WEATHER_PROFILES.clear.wind));
  return {
    rippleAmpScale: 1 + rough * 0.85,
    rippleSpeedScale: 1 + rough * 0.65,
    foamScale: 1 + wind * 0.25,
  };
}
```

Set `uRippleAmp = WATER_RIPPLE_AMP * scale`, `uRippleSpeed = WATER_RIPPLE_SPEED * scale`, and
multiply foam by `uWeatherFoamScale` before daylight scaling. Clear remains exact identity.

In `main.ts`, pass `atmosphere.weatherSnapshot.rain` to `roadRenderer.update` and the complete
snapshot to `terrain.update`.

- [x] **Step 4: Run focused tests and build**

Run: `npx vitest run tests/weather.test.ts tests/roadWeather.test.ts && npm run build`

Expected: all pass; low/high quality compile the same uniforms.

- [x] **Step 5: Commit**

```bash
git add src/render/terrainRenderer.ts src/main.ts tests/weather.test.ts tests/roadWeather.test.ts
git commit -m "feat(render): make roads and water respond to living weather"
```

---

### Task 4: Restrained tree sway and field ripple

**Files:**
- Modify: `src/render/sceneryRenderer.ts`
- Create: `tests/sceneryWeather.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- `SceneryRenderer.update(dt, weatherWind = 0)`.
- Shared uniforms `uWeatherTime` and `uWeatherWind` installed once per tree/field material.

- [ ] **Step 1: Write failing shader-installation tests**

Export:

```ts
export interface WeatherWindUniforms {
  time: { value: number };
  wind: { value: number };
}
export function weatherWindUniforms(): WeatherWindUniforms;
export function installTreeWind(material: THREE.MeshStandardMaterial, uniforms: WeatherWindUniforms): void;
export function installFieldWind(material: THREE.MeshStandardMaterial, uniforms: WeatherWindUniforms): void;
```

Tests compile the hook against a minimal shader object:

```ts
function fakeStandardShader() {
  return {
    uniforms: {} as Record<string, { value: number }>,
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>',
  };
}

it('injects shared, bounded tree sway without replacing standard lighting', () => {
  const material = new THREE.MeshStandardMaterial();
  const uniforms = weatherWindUniforms();
  installTreeWind(material, uniforms);
  const shader = fakeStandardShader();
  material.onBeforeCompile(shader as never, {} as never);
  expect(shader.uniforms.uWeatherWind).toBe(uniforms.wind);
  expect(shader.vertexShader).toContain('groundworkTreeWind');
  expect(shader.vertexShader).toContain('#include <project_vertex>');
});

it('updates one shared wind scalar without replacing instance matrices', () => {
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const renderer = new SceneryRenderer(scene, new Heightfield('weather-wind', bus), bus);
  const before = renderer.instanceStats;
  renderer.update(1, 0.8);
  expect(renderer.instanceStats).toEqual(before);
  const internal = renderer as unknown as { weatherWind: WeatherWindUniforms };
  expect(internal.weatherWind.wind.value).toBeCloseTo(0.8);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/sceneryWeather.test.ts`

Expected: wind helpers absent.

- [ ] **Step 3: Install material-level wind once**

Patch `<common>` with uniforms and patch `<begin_vertex>`:

```glsl
float groundworkTreeWind = sin((instanceMatrix[3].x + instanceMatrix[3].z) * 0.08 + uWeatherTime * 1.7);
float groundworkHeight = clamp(position.y / 5.0, 0.0, 1.0);
transformed.xz += vec2(1.0, 0.35) * groundworkTreeWind * uWeatherWind * groundworkHeight * 0.12;
```

For field materials, add a vertical ripple no larger than `0.025 * wind`. Apply tree hook to every
fallback and loaded styled tree material after cloning; apply field hook to field and stripe
materials. All materials share the same two uniform objects. `update` advances time and assigns the
snapshot wind; it does not iterate or rewrite tree matrices.

Store the shared object as `private readonly weatherWind: WeatherWindUniforms`; tests may inspect it
through the same structural-private pattern already used elsewhere, without adding a public
test-only method.

- [ ] **Step 4: Run scenery and full render tests**

Run: `npx vitest run tests/sceneryWeather.test.ts tests/sceneryDecay.test.ts tests/modelStyles.test.ts`

Expected: all pass; model fallback and GLTF paths both install wind hooks.

- [ ] **Step 5: Commit**

```bash
git add src/render/sceneryRenderer.ts src/main.ts tests/sceneryWeather.test.ts
git commit -m "feat(render): add restrained weather wind to vegetation"
```

---

### Task 5: Restore weather and show it in the Guide

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/hud.ts`
- Modify: `tests/hud.test.ts`
- Modify: `tests/save.test.ts`

**Interfaces:**
- `SiteOverview` adds `weather: WeatherKind`.
- `formatSiteOverview` adds `WEATHER   <LABEL>` as the fifth line, moving SIM to sixth.

- [ ] **Step 1: Write failing HUD and live-weather save tests**

```ts
it('formats current weather without adding toolbar controls', () => {
  const lines = formatSiteOverview({
    roads: 4, scheduledJobs: 0, activeCrews: 0, cars: 6, homes: 3, buildings: 1,
    paused: false, growthPaused: false, weather: 'coastal-fog',
  });
  expect(lines).toContain('WEATHER   COASTAL FOG');
  expect(lines).toHaveLength(6);
});

it('serializes the controller state rather than the clear reservation default', () => {
  const weather = new WeatherController('save-live-weather', {
    current: 'heavy-rain', next: 'light-rain', transition: 0.25, remaining: 41, transitionIndex: 8,
  });
  const world = freshWorld('save-live-weather');
  const save = deserialize(serialize({
    seed: 'save-live-weather', timeOfDay: 0.5, graph: world.graph, growth: world.growth,
    quarry: world.quarry, junctionControls: [], weather: weather.saved,
  }))!;
  expect(save.weather).toEqual(weather.saved);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/hud.test.ts tests/save.test.ts`

Expected: `SiteOverview.weather`/sixth line absent or main still saves default weather.

- [ ] **Step 3: Wire controller restore/save and Guide refresh**

Construct `WeatherController` before `Atmosphere` and pass it in. On restore call
`weather.restore(save.weather)` before the first post-restore frame. Autosave passes
`weather: weather.saved` rather than `DEFAULT_WEATHER_SAVE`.

Add weather to `getSiteOverview`. Increase Guide overview line elements from 5 to 6. Add labels:

```ts
const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'CLEAR', overcast: 'OVERCAST', 'light-rain': 'LIGHT RAIN',
  'heavy-rain': 'HEAVY RAIN', 'coastal-fog': 'COASTAL FOG',
};
```

In `buildGuideOverlay`, change the loop bound to 6 and change the accent condition from `i === 4`
to `i === 5` so the final SIM line remains highlighted rather than the new weather line.

Listen to `atmosphere:weather` only to refresh an open Guide; do not show transient notices for
every weather transition.

- [ ] **Step 4: Prove presentation-only isolation**

Add this paired integration test. It runs identical graph/build/traffic/growth fixed steps while
advancing different weather dt values only on the presentation side:

```ts
function simulationProjection(weatherDt: number) {
  const seed = 'weather-isolation';
  const bus = new EventBus();
  const hf = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(hf));
  const queue = new BuildQueue(graph, hf, bus);
  const growth = new GrowthSim(graph, hf, bus, createRng('growth-' + seed));
  const control = new JunctionControlSim(graph, bus);
  const traffic = new TrafficSim(graph, bus, createRng('traffic-' + seed), control);
  const weather = new WeatherController(seed);
  let anchor: { x: number; z: number } | null = null;
  for (let x = -120; x <= 88 && !anchor; x += 8) {
    for (let z = -120; z <= 120; z += 8) {
      if (hf.isLand(x, z) && hf.isLand(x + 32, z)) { anchor = { x, z }; break; }
    }
  }
  if (!anchor) throw new Error('no weather-isolation road anchor');
  graph.commitChain([anchor, { x: anchor.x + 32, z: anchor.z }]);
  for (let tick = 0; tick < 60 * 180; tick++) {
    queue.update(1 / 60, false);
    traffic.update(1 / 60, 0.5);
    control.update(1 / 60);
    growth.update(1 / 60);
    weather.update(weatherDt);
  }
  return {
    edges: [...graph.edges.values()].map((e) => ({ ctrl: e.ctrl, stage: e.stage })),
    growth: growth.spawned.map((r) => ({ ...r })),
    cars: traffic.cars.map((c) => ({ id: c.id, pos: c.pos, speed: c.speed })),
  };
}

it('does not feed weather back into authoritative simulation', () => {
  expect(simulationProjection(1 / 120)).toEqual(simulationProjection(1 / 10));
});
```

Run: `npx vitest run tests/weather.test.ts tests/hud.test.ts tests/save.test.ts tests/traffic.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/ui/hud.ts tests/hud.test.ts tests/save.test.ts tests/weather.test.ts
git commit -m "feat(ui): persist and report living weather"
```

---

### Task 6: Weather visual matrix, performance, handoff, and deploy gate

**Files:**
- Modify: `docs/HANDOFF.md`
- Modify only if verification finds defects: files owned by Tasks 1–5.

**Interfaces:**
- Consumes: complete weather implementation.
- Produces: deploy-ready combined program.

- [ ] **Step 1: Run the day/night/weather visual matrix**

Inspect clear, overcast, light rain, heavy rain, and fog at noon/night on both quality tiers. Confirm
road readability, no bright night water, visible-but-restrained rain, distinct fog, stable signal
emissives, and no cloud popping during transitions.

- [ ] **Step 2: Check desktop and mobile Guide layout**

Verify six overview lines fit at 375×812 and desktop, focus/escape still work, and no permanent
weather toolbar control was added.

- [ ] **Step 3: Profile bounded cost**

At high tier with a built-out town, measure draw calls and frame submission in clear and heavy rain.
Confirm draw calls remain below 250, cloud/rain geometry is reused, and no per-frame material,
geometry, or array allocation appears in changed update methods.

- [ ] **Step 4: Run final checks**

```bash
npm test
npm run build
git diff --check
rg -n "TEMP|DEBUG|__gw|console\.log|debugger" src tests
git status --short
```

Expected: full green, existing bundle-size advisory only, no temporary hooks.

- [ ] **Step 5: Update handoff and commit**

Document weather profiles, fog floors, Save V4 state, presentation-only boundary, control thresholds,
and visual/performance evidence:

```bash
git add docs/HANDOFF.md
git commit -m "docs: hand off junction controls and living weather"
```

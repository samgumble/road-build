import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { createRng } from '../src/core/rng';
import { WEATHER_KINDS, WEATHER_PROFILES, type WeatherKind } from '../src/core/weather';
import { WeatherController } from '../src/render/weather';
import { waterWeatherValues } from '../src/render/weatherTuning';
import { GrowthSim } from '../src/sim/growth/growth';
import { makeSampler } from '../src/sim/roads/path';
import { RoadGraph } from '../src/sim/roads/graph';
import { Heightfield } from '../src/sim/terrain/heightfield';
import { TrafficSim } from '../src/sim/traffic/traffic';

function authoritativeWorld(seed: string) {
  const bus = new EventBus();
  const heightfield = new Heightfield(seed, bus);
  const graph = new RoadGraph(bus, makeSampler(heightfield));
  let anchor: { x: number; z: number } | null = null;
  outer: for (let x = -160; x <= 160; x += 8) {
    for (let z = -160; z <= 160; z += 8) {
      if (!heightfield.isLand(x, z) || !heightfield.isLand(x + 64, z)) continue;
      anchor = { x, z };
      break outer;
    }
  }
  if (!anchor) throw new Error('no weather-isolation road anchor');

  graph.commitChain([anchor, { x: anchor.x + 64, z: anchor.z }]);
  for (const edge of graph.edges.values()) edge.stage = 'painted';

  const growth = new GrowthSim(graph, heightfield, bus, createRng(`${seed}:growth`), 0.217);
  const traffic = new TrafficSim(graph, bus, createRng(`${seed}:traffic`));
  traffic.targetPopulation = 4;
  bus.emit('roads:changed', {});

  return { graph, growth, traffic };
}

function authoritativeSnapshot(world: ReturnType<typeof authoritativeWorld>) {
  return {
    nodes: [...world.graph.nodes.values()].map((node) => ({ ...node })),
    edges: [...world.graph.edges.values()].map((edge) => ({
      id: edge.id,
      a: edge.a,
      b: edge.b,
      ctrl: edge.ctrl.map((point) => ({ ...point })),
      stage: edge.stage,
    })),
    growth: {
      devLevels: world.growth.devLevels,
      spawned: world.growth.spawned.map((record) => ({ ...record })),
      houseCount: world.growth.houseCount,
      decay: world.growth.decayState,
    },
    traffic: world.traffic.cars.map((car) => ({
      ...car,
      lane: world.traffic.laneAndS(car.id),
    })),
  };
}

describe('WeatherController', () => {
  it('defines a complete bounded profile for every weather kind', () => {
    expect(Object.keys(WEATHER_PROFILES)).toEqual([...WEATHER_KINDS]);

    for (const kind of WEATHER_KINDS) {
      expect(WEATHER_PROFILES[kind].kind).toBe(kind);
      for (const key of ['cloudCover', 'cloudDarkness', 'rain', 'fog', 'wind', 'waterRoughness'] as const) {
        expect(WEATHER_PROFILES[kind][key]).toBeGreaterThanOrEqual(0);
        expect(WEATHER_PROFILES[kind][key]).toBeLessThanOrEqual(1);
      }
    }
  });

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
    for (let i = 0; i < 1000 && original.saved.transition >= 1; i++) original.update(1);
    if (original.saved.transition === 0) original.update(0.5);
    expect(original.saved.transition).toBeGreaterThan(0);
    expect(original.saved.transition).toBeLessThan(1);
    const restored = new WeatherController('restore-weather', original.saved);
    for (let i = 0; i < 300; i++) {
      original.update(1);
      restored.update(1);
    }
    expect(restored.saved).toEqual(original.saved);
    expect(restored.snapshot).toEqual(original.snapshot);
  });

  it('reuses its presentation snapshot while values evolve', () => {
    const weather = new WeatherController('stable-snapshot', {
      current: 'overcast', next: 'light-rain', transition: 0, remaining: 0, transitionIndex: 3,
    });
    const snapshot = weather.snapshot;

    weather.update(1);

    expect(weather.snapshot).toBe(snapshot);
    expect(snapshot.rain).toBeGreaterThan(0);
  });

  it('returns detached save records and can restore the initial deterministic timeline', () => {
    const weather = new WeatherController('detached-save');
    const initial = weather.saved;
    initial.remaining = 0;
    expect(weather.saved.remaining).not.toBe(0);

    weather.update(75);
    weather.restore(initial);
    expect(weather.saved).toEqual(initial);
  });

  it('cannot change authoritative simulation outcomes when updated at a different cadence', () => {
    const everyTick = authoritativeWorld('weather-isolation');
    const batched = authoritativeWorld('weather-isolation');
    const changingWeather = {
      current: 'overcast' as const,
      next: 'light-rain' as const,
      transition: 0,
      remaining: 0,
      transitionIndex: 3,
    };
    const smoothWeather = new WeatherController('weather-isolation', changingWeather);
    const batchedWeather = new WeatherController('weather-isolation', changingWeather);
    const dt = 1 / 60;
    const ticks = 900;
    let smoothUpdates = 0;
    let batchedUpdates = 0;

    for (let tick = 0; tick < ticks; tick++) {
      smoothWeather.update(dt);
      smoothUpdates++;
      if ((tick + 1) % 4 === 0) {
        batchedWeather.update(dt * 4);
        batchedUpdates++;
      }

      everyTick.growth.update(dt);
      everyTick.traffic.update(dt, 0.3);
      batched.growth.update(dt);
      batched.traffic.update(dt, 0.3);
    }

    expect(smoothUpdates).toBe(900);
    expect(batchedUpdates).toBe(225);
    expect(smoothWeather.saved.transitionIndex).toBeGreaterThan(3);
    expect(batchedWeather.saved.transitionIndex).toBeGreaterThan(3);
    expect(authoritativeSnapshot(batched)).toEqual(authoritativeSnapshot(everyTick));
    expect(everyTick.traffic.cars.length).toBeGreaterThan(0);
    expect(everyTick.growth.devLevels.some((level) => level > 0)).toBe(true);
  });
});

describe('water weather response', () => {
  it('leaves the authored clear-water presentation unchanged', () => {
    expect(waterWeatherValues(WEATHER_PROFILES.clear)).toEqual({
      rippleAmpScale: 1,
      rippleSpeedScale: 1,
      foamScale: 1,
    });
  });

  it('reuses a supplied output object for allocation-free frame updates', () => {
    const scratch = { rippleAmpScale: 0, rippleSpeedScale: 0, foamScale: 0 };

    expect(waterWeatherValues(WEATHER_PROFILES['light-rain'], scratch)).toBe(scratch);
    expect(scratch.rippleAmpScale).toBeGreaterThan(1);
    expect(scratch.rippleSpeedScale).toBeGreaterThan(1);
    expect(scratch.foamScale).toBeGreaterThan(1);
  });

  it('makes storm water visibly rougher and faster while keeping fog water calmer', () => {
    const heavyRain = waterWeatherValues(WEATHER_PROFILES['heavy-rain']);
    const coastalFog = waterWeatherValues(WEATHER_PROFILES['coastal-fog']);

    expect(heavyRain.rippleAmpScale).toBeGreaterThan(1.5);
    expect(heavyRain.rippleSpeedScale).toBeGreaterThan(1.4);
    expect(heavyRain.foamScale).toBeGreaterThan(1);
    expect(coastalFog.rippleAmpScale).toBeLessThan(heavyRain.rippleAmpScale);
    expect(coastalFog.foamScale).toBe(1);
  });
});

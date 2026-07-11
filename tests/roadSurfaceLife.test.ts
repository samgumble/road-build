import { describe, expect, it } from 'vitest';
import { deterministicRoadDetail, puddleOpacity, surfaceDetailStations, trafficWear } from '../src/render/roadRenderer';

describe('deterministic road surface life', () => {
  it('produces stable per-edge detail while varying between edges', () => {
    expect(deterministicRoadDetail(7, 3)).toBe(deterministicRoadDetail(7, 3));
    expect(deterministicRoadDetail(7, 3)).not.toBe(deterministicRoadDetail(8, 3));
  });

  it('places bounded deterministic patches and puddles away from edge endpoints', () => {
    const a = surfaceDetailStations(12, 100);
    const b = surfaceDetailStations(12, 100);
    expect(a).toEqual(b);
    expect(a.patches.length).toBeGreaterThan(0);
    expect(a.puddles.length).toBeGreaterThan(0);
    expect([...a.patches, ...a.puddles].every((d) => d > 4 && d < 96)).toBe(true);
  });

  it('traffic wear is monotonic and capped', () => {
    expect(trafficWear(0)).toBe(0);
    expect(trafficWear(5)).toBeGreaterThan(trafficWear(1));
    expect(trafficWear(50)).toBe(1);
    expect(trafficWear(5000)).toBe(1);
  });

  it('keeps puddles invisible when dry and fades them in with rain', () => {
    expect(puddleOpacity(0)).toBe(0);
    expect(puddleOpacity(0.5)).toBeCloseTo(0.17, 8);
    expect(puddleOpacity(2)).toBeCloseTo(0.34, 8);
  });
});

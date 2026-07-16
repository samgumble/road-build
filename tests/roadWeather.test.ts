import { describe, expect, it } from 'vitest';
import { WEATHER_PROFILES } from '../src/core/weather';
import { wetRoadAppearance } from '../src/render/roadRenderer';

describe('wet road appearance', () => {
  it('is an exact no-op when the road is dry', () => {
    expect(wetRoadAppearance('asphalt', 0, 0.9)).toEqual({ colorScale: 1, roughness: 0.9 });
  });

  it('darkens and glosses asphalt more strongly than gravel or earth', () => {
    const asphalt = wetRoadAppearance('asphalt', 1, 0.9);
    const gravel = wetRoadAppearance('gravel', 1, 0.9);
    const earth = wetRoadAppearance('earth', 1, 0.9);
    expect(asphalt.colorScale).toBeLessThan(gravel.colorScale);
    expect(gravel.colorScale).toBeLessThan(earth.colorScale);
    expect(asphalt.roughness).toBeLessThan(gravel.roughness);
    expect(gravel.roughness).toBeLessThan(earth.roughness);
  });

  it('preserves an already-glossier fresh asphalt surface while adding rain', () => {
    const wetFresh = wetRoadAppearance('asphalt', 1, 0.35);
    expect(wetFresh.roughness).toBeLessThan(0.35);
    expect(wetFresh.roughness).toBeGreaterThanOrEqual(0.18);
  });

  it('clamps rain input so appearance never overshoots its authored range', () => {
    expect(wetRoadAppearance('paint', 2, 0.85)).toEqual(wetRoadAppearance('paint', 1, 0.85));
    expect(wetRoadAppearance('paint', -1, 0.85)).toEqual(wetRoadAppearance('paint', 0, 0.85));
  });

  it('uses the blended weather snapshot rain amount without changing clear roads', () => {
    expect(wetRoadAppearance('asphalt', WEATHER_PROFILES.clear.rain, 0.9)).toEqual({
      colorScale: 1,
      roughness: 0.9,
    });
    expect(wetRoadAppearance('asphalt', WEATHER_PROFILES['heavy-rain'].rain, 0.9)).toEqual(
      wetRoadAppearance('asphalt', 1, 0.9),
    );
  });
});

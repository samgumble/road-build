import { describe, expect, it } from 'vitest';
import { MODEL_STYLE_VARIANTS } from '../src/render/sceneryRenderer';

describe('runtime model asset uplift', () => {
  it('expands the six source GLBs into a materially richer deterministic variant library', () => {
    expect(MODEL_STYLE_VARIANTS.tree).toHaveLength(3);
    expect(MODEL_STYLE_VARIANTS.house).toHaveLength(4);
    expect(MODEL_STYLE_VARIANTS.building).toHaveLength(4);

    // 3 tree files * 3 styles + 2 house files * 4 styles + 1 building * 4 styles.
    expect(3 * MODEL_STYLE_VARIANTS.tree.length
      + 2 * MODEL_STYLE_VARIANTS.house.length
      + MODEL_STYLE_VARIANTS.building.length).toBeGreaterThanOrEqual(20);
  });

  it('includes silhouette changes, not color-only duplicates', () => {
    for (const styles of Object.values(MODEL_STYLE_VARIANTS)) {
      expect(new Set(styles.map((style) => `${style.widthScale}:${style.heightScale}`)).size)
        .toBeGreaterThan(1);
    }
  });
});

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

  /**
   * Hard-clamps terrain within `radius` of (x, z) so it never pokes above the roadbed (playtest
   * fix: "the land is still rendering above the cleared road in some areas"). Unlike
   * `flattenCircle` (a blended smoothstep pull toward `targetY`, which can still leave terrain
   * vertices above the roadbed on cross-slopes even after multiple overlapping passes), this only
   * ever pulls a vertex DOWN, and only when it's above the allowed ceiling — never raises terrain.
   * The ceiling is `maxY` at the core (d=0), rising smoothly to `maxY + 2.5` at the rim (d=radius)
   * so there's no hard vertical cliff at the clamp boundary; the allowance only starts growing
   * past d/radius = 0.3, mirroring `flattenCircle`'s own feather structure.
   */
  clampBelow(x: number, z: number, maxY: number, radius: number): void {
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
        const ceiling = maxY + smoothstep(0.3, 1.0, d) * 2.5;
        const idx = j * GRID_SIZE + i;
        if (this.heights[idx] > ceiling) this.heights[idx] = ceiling;
      }
    }
    this.bus?.emit('terrain:deformed', { minI, minJ, maxI, maxJ });
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

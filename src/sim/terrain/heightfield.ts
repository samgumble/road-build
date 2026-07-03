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
   *
   * Second occurrence (T24 finding, after T18's original version of this method): a single
   * `smoothstep(0.3, 1.0, d) * 2.5` allowance starting at d/radius = 0.3 let terrain sit up to
   * ~1.4-2.5u above the roadbed at d values that still land INSIDE the visible ribbon corridor —
   * e.g. on a diagonal road, grid vertices at d ~= 0.7-0.85 of a clampBelow call centered on a
   * nearby sample are still well within the road's ROAD_WIDTH/2 footprint once you account for
   * the vertex being off-axis from that particular sample. Fixed by splitting the ceiling into two
   * zones against `flatRadius` (world units, <= radius): a true no-allowance flat ceiling out to
   * `flatRadius`, then a smoothstep rise back to +2.5 out to the rim at `radius` (so embankments
   * beyond the road still blend smoothly, no cliff).
   *
   * `flatRadius` alone isn't enough, though: widening it far enough to flat-clamp every grid
   * vertex that could bilinearly bleed into the visible corridor (up to a full grid cell's
   * diagonal, ~5.7u) turned out to reach far enough ALONG a curved/hilly road's own arclength to
   * pull in a *different* sample whose true target elevation legitimately differs by several
   * units — clamping terrain down that was correctly following a closer, higher sample
   * (`tests/queue.test.ts`'s "grading deforms terrain toward the road profile" caught this
   * regression). Perpendicular reach (across the road, where elevation is ~constant along a single
   * cross-section) and arclength reach (along the road, where elevation genuinely varies) are
   * different concerns that a single circular radius conflates.
   *
   * So this optionally takes a `heading` (radians) plus separate `alongRadius`/`alongFlatRadius`
   * for the tangent axis: when provided, distance is measured in the road's own local frame, as
   * two INDEPENDENT normalized fractions rather than one blended ellipse (simpler to reason about,
   * and the two axes' feather curves never need to interpolate into each other) —
   *  - `dAcross` = perpendicular offset / `radius` (generous: elevation is ~constant across one
   *    cross-section of the road, so reaching the full corridor width here is safe)
   *  - `dAlong` = tangent offset / `alongRadius` (narrow: kept close to the sample's own position
   *    so it can never reach a neighboring sample with meaningfully different target elevation)
   * A vertex is in range if BOTH fractions are < 1 (an axis-aligned rectangle in the road's local
   * frame, corners rounded by taking the max of the two as the combined "how deep into the
   * footprint" value below). It's in the true flat zone if both fractions are also under their
   * own flat threshold; otherwise the ceiling rises smoothly with however far *either* axis has
   * pushed past its flat threshold. Omitting `heading` collapses this to the original isotropic
   * circle (`alongRadius`/`alongFlatRadius` default to the perpendicular ones, and with no
   * rotation "along"/"across" are just world dx/dz).
   */
  clampBelow(
    x: number,
    z: number,
    maxY: number,
    radius: number,
    flatRadius: number = radius,
    heading?: number,
    alongRadius: number = radius,
    alongFlatRadius: number = flatRadius,
  ): void {
    const half = WORLD_SIZE / 2;
    const maxReach = Math.max(radius, alongRadius);
    const minI = Math.max(0, Math.floor((x - maxReach + half) / CELL));
    const maxI = Math.min(GRID_SIZE - 1, Math.ceil((x + maxReach + half) / CELL));
    const minJ = Math.max(0, Math.floor((z - maxReach + half) / CELL));
    const maxJ = Math.min(GRID_SIZE - 1, Math.ceil((z + maxReach + half) / CELL));
    const flatDAcross = Math.min(1, flatRadius / radius);
    const flatDAlong = Math.min(1, alongFlatRadius / alongRadius);
    const cosH = heading !== undefined ? Math.cos(heading) : 1;
    const sinH = heading !== undefined ? Math.sin(heading) : 0;
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const wx = i * CELL - half, wz = j * CELL - half;
        const dx = wx - x, dz = wz - z;
        // Project (dx, dz) onto the tangent ("along") / perpendicular ("across") axes of
        // `heading`. With no heading given, cosH=1/sinH=0 makes along=dx, across=dz — and since
        // alongRadius/alongFlatRadius default to radius/flatRadius in that case too, this whole
        // method degenerates exactly to the original isotropic circle.
        const along = dx * cosH + dz * sinH;
        const across = -dx * sinH + dz * cosH;
        const dAlong = Math.abs(along) / alongRadius;
        const dAcross = Math.abs(across) / radius;
        if (dAlong >= 1 || dAcross >= 1) continue; // outside the footprint on either axis
        const inFlatZone = dAlong <= flatDAlong && dAcross <= flatDAcross;
        let ceiling: number;
        if (inFlatZone) {
          ceiling = maxY;
        } else {
          // How far past its own flat threshold each axis has pushed, normalized 0..1 against the
          // remaining room to that axis's rim — take whichever axis is furthest past its
          // threshold so the rise only starts once BOTH axes are within their flat zones, and
          // reaches full allowance once EITHER axis reaches its own rim.
          const pastAlong = dAlong <= flatDAlong ? 0 : (dAlong - flatDAlong) / (1 - flatDAlong || 1);
          const pastAcross = dAcross <= flatDAcross ? 0 : (dAcross - flatDAcross) / (1 - flatDAcross || 1);
          const t = Math.max(pastAlong, pastAcross);
          ceiling = maxY + smoothstep(0, 1, t) * 2.5;
        }
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

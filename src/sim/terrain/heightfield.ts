import { createNoise2D } from 'simplex-noise';
import { createRng } from '../../core/rng';
import { EventBus } from '../../core/events';
import { GRID_SIZE, CELL, WORLD_SIZE, WATER_LEVEL } from '../../core/constants';

/** One road sample's clamp constraint, as registered by `Heightfield.registerRoadEasement` — the
 * exact same parameters `clampBelow` itself takes, captured so they can be REPLAYED after any
 * later deformer (flattenCircle from a house pad, a quarry pad, or anything else) mutates
 * overlapping terrain. See `registerRoadEasement`'s doc comment for the full rationale. */
interface EasementSample {
  x: number; z: number; y: number; heading: number;
  radius: number; flatRadius: number; alongRadius: number; alongFlatRadius: number;
}

// Bucket size for the easement spatial index — matches the grid cell so a mutated bounding box
// (already expressed in grid indices by every caller) maps directly onto bucket indices with no
// extra rounding logic.
const EASEMENT_BUCKET = CELL;

export class Heightfield {
  readonly heights = new Float32Array(GRID_SIZE * GRID_SIZE);

  // --- Road easements (Groundwork Task 43: "grass on top of the road", third occurrence) --------
  // T24's clampBelow enforcement only ever ran at grading completion, a mid-build trailing window,
  // and save.ts's restore path — all BEFORE construction finishes. But terrain keeps deforming
  // AFTER a road is done: growth spawns a house/building pad (SceneryRenderer.place,
  // flattenCircle radius 5) at a T30 setback of just 8-10u from the centerline, close enough that
  // its blended pad — when the house sits uphill of a cut road — RAISES corridor terrain the
  // road's own clampBelow had already flattened. The quarry pad (ConstructionRenderer,
  // flattenCircle radius 13) has the same structural risk against any road built near it later.
  // Point-fixing each caller (T24's own architecture, twice now) keeps missing the NEXT deformer.
  //
  // Root fix: every graded+ road sample registers its own clampBelow constraint HERE, in the one
  // chokepoint every deformer (sim or render, present or future) already calls through —
  // `flattenCircle`. After any `flattenCircle` mutates a region, it re-applies every registered
  // easement whose footprint overlaps that region, restoring the invariant "no terrain above the
  // roadbed inside a graded corridor" regardless of what just tried to violate it. New deformers
  // are safe BY DEFAULT — they don't need to know easements exist at all.
  private readonly easements = new Map<number, EasementSample[]>();
  // Spatial index: bucket key -> list of (edgeId, sampleIndex) pairs, so re-applying easements
  // after a small localized deform (a house pad) only visits nearby samples, not every registered
  // sample on the map (which could be in the thousands on a fully built-out island).
  private readonly easementBuckets = new Map<string, { edgeId: number; idx: number }[]>();

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
    // Road-easement re-enforcement (Task 43): this deform may have just raised terrain back above
    // a graded road's ceiling (e.g. a house/quarry pad's blend reaching into the corridor) — replay
    // any registered clampBelow constraints whose footprint overlaps the region we just touched so
    // the "no terrain above the roadbed" invariant holds regardless of what deformed it.
    this.reapplyEasementsNear(minI, minJ, maxI, maxJ);
    this.bus?.emit('terrain:deformed', { minI, minJ, maxI, maxJ });
  }

  /** World-space bucket coordinate for `w` (an x or z coordinate), used as one half of the
   * easement spatial index's key. Bucketing in world units (rather than grid indices) keeps
   * `registerRoadEasement` and `reapplyEasementsNear` — which work in different unit systems
   * (sample world positions vs. mutated grid-index boxes) — trivially consistent with each other. */
  private static bucketCoord(w: number): number {
    return Math.floor(w / EASEMENT_BUCKET);
  }

  /**
   * Registers `edgeId`'s graded+ road samples as standing terrain-clamp constraints, replayed by
   * every future `flattenCircle` call that deforms overlapping terrain (see that method and the
   * class-level doc comment above `easements` for the full rationale). Call with the same
   * parameters `clampBelow` itself would use (mirrors `queue.ts`'s `finalizeGrading` /
   * `save.ts`'s restore-path clamp sweep) — typically once, right when an edge reaches 'graded'.
   * Replaces any previous registration for the same `edgeId` (idempotent — safe to call again if
   * an edge's samples are re-sampled, e.g. after an upstream terrain edit).
   */
  registerRoadEasement(
    edgeId: number,
    samples: { x: number; y: number; z: number; bridge: boolean }[],
    headingAt: (i: number) => number,
    radius: number,
    flatRadius: number,
    alongRadius: number,
    alongFlatRadius: number,
  ): void {
    this.unregisterRoadEasement(edgeId);
    const list: EasementSample[] = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.bridge) continue;
      list.push({
        x: s.x, z: s.z, y: s.y, heading: headingAt(i),
        radius, flatRadius, alongRadius, alongFlatRadius,
      });
    }
    this.easements.set(edgeId, list);
    for (let k = 0; k < list.length; k++) {
      const es = list[k];
      const maxReach = Math.max(es.radius, es.alongRadius);
      const bi0 = Heightfield.bucketCoord(es.x - maxReach);
      const bi1 = Heightfield.bucketCoord(es.x + maxReach);
      const bj0 = Heightfield.bucketCoord(es.z - maxReach);
      const bj1 = Heightfield.bucketCoord(es.z + maxReach);
      for (let bj = bj0; bj <= bj1; bj++) {
        for (let bi = bi0; bi <= bi1; bi++) {
          const key = `${bi},${bj}`;
          let arr = this.easementBuckets.get(key);
          if (!arr) { arr = []; this.easementBuckets.set(key, arr); }
          arr.push({ edgeId, idx: k });
        }
      }
    }
  }

  /** Removes `edgeId`'s registered easement (demolish reaching below 'graded', or the edge being
   * removed from the graph entirely) so a torn-up road stops constraining terrain forever. */
  unregisterRoadEasement(edgeId: number): void {
    if (!this.easements.has(edgeId)) return;
    this.easements.delete(edgeId);
    for (const arr of this.easementBuckets.values()) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].edgeId === edgeId) arr.splice(i, 1);
      }
    }
  }

  /** Re-applies every registered easement whose footprint could overlap the grid index box
   * `[minI,maxI] x [minJ,maxJ]` (in the SAME grid-index units `flattenCircle`/`clampBelow` already
   * compute their own mutated bounding box in) — called after any `flattenCircle` deform. Uses the
   * bucket index to gather only nearby easement samples rather than scanning every registered
   * sample on the map, so this stays cheap even with hundreds of graded edges. Safe/cheap no-op
   * when nothing is registered yet (the common case for most of the game before any road exists).
   */
  private reapplyEasementsNear(minI: number, minJ: number, maxI: number, maxJ: number): void {
    if (this.easements.size === 0) return;
    const half = WORLD_SIZE / 2;
    const minX = minI * CELL - half, maxX = maxI * CELL - half;
    const minZ = minJ * CELL - half, maxZ = maxJ * CELL - half;
    const bi0 = Heightfield.bucketCoord(minX);
    const bi1 = Heightfield.bucketCoord(maxX);
    const bj0 = Heightfield.bucketCoord(minZ);
    const bj1 = Heightfield.bucketCoord(maxZ);
    const seen = new Set<string>();
    for (let bj = bj0; bj <= bj1; bj++) {
      for (let bi = bi0; bi <= bi1; bi++) {
        const key = `${bi},${bj}`;
        const arr = this.easementBuckets.get(key);
        if (!arr) continue;
        for (const ref of arr) {
          const dedupeKey = `${ref.edgeId}:${ref.idx}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const list = this.easements.get(ref.edgeId);
          const es = list?.[ref.idx];
          if (!es) continue;
          this.applyClampBelow(es.x, es.z, es.y, es.radius, es.flatRadius, es.heading, es.alongRadius, es.alongFlatRadius);
        }
      }
    }
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
    const { minI, minJ, maxI, maxJ } = this.applyClampBelow(x, z, maxY, radius, flatRadius, heading, alongRadius, alongFlatRadius);
    this.bus?.emit('terrain:deformed', { minI, minJ, maxI, maxJ });
  }

  /** Core clamp loop shared by the public `clampBelow` (emits `terrain:deformed`, for direct
   * callers like `queue.ts`/`save.ts`) and `reapplyEasementsNear` (replays a registered easement
   * after some OTHER deform touched overlapping terrain — deliberately no event emission there,
   * since it's re-enforcing an already-known constraint (not a new deform of its own) and callers
   * of the original deform already got their own `terrain:deformed` event for this region. A hard
   * clamp-down also can never itself raise terrain above another easement's ceiling, so there's no
   * cascade to worry about even though `flattenCircle`'s own reapply call isn't guarded against
   * one — `applyClampBelow` never recurses into `reapplyEasementsNear` at all. */
  private applyClampBelow(
    x: number,
    z: number,
    maxY: number,
    radius: number,
    flatRadius: number,
    heading: number | undefined,
    alongRadius: number,
    alongFlatRadius: number,
  ): { minI: number; minJ: number; maxI: number; maxJ: number } {
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
    return { minI, minJ, maxI, maxJ };
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

import type { P2, RoadSample, V3 } from '../../core/types';
import { Heightfield } from '../terrain/heightfield';
import { MAX_ROAD_GRADE, WATER_LEVEL, WORLD_SIZE, SNAP } from '../../core/constants';

const SPACING = 2;
const LOCAL_SMOOTH_SPAN = SNAP * 2.5;
const CORNER_RADIUS = 4;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

/** Preserve the established sample distribution for a two-stake straight road. Terrain grading
 * and its anisotropic clamp have years of regression coverage against this distribution, while a
 * two-point line contains no hand-drawn wobble or corner to improve. */
function sampleStraightLegacy(ctrl: P2[]): P2[] {
  const [a, b] = ctrl;
  const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SPACING));
  const out: P2[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / n;
    out.push({
      x: catmullRom(a.x, a.x, b.x, b.x, t),
      z: catmullRom(a.z, a.z, b.z, b.z, t),
    });
  }
  out.push({ ...b });
  return out;
}

function lerpPoint(a: P2, b: P2, t: number): P2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function appendLine(out: P2[], a: P2, b: P2, includeEnd = false): void {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / SPACING));
  const first = out.length ? 1 : 0;
  const last = includeEnd ? steps : steps - 1;
  for (let i = first; i <= last; i++) out.push(lerpPoint(a, b, i / steps));
}

/**
 * Produces the shared render/terrain/traffic centerline for a player-drawn road.
 *
 * DrawTool records every changed grid snap, which makes a gently drawn road look like a chain of
 * tiny stair-steps. Two conservative Laplacian passes absorb only short local wobble; long-leg
 * corners remain fixed. The second pass rounds those retained corners with bounded quadratic
 * fillets. Endpoints stay bit-exact so junctions, loop closure, save replay, and lane connectivity
 * continue to use the authoritative snapped graph positions. Quadratic fillets remain inside the
 * adjacent-segment envelope, avoiding Catmull-Rom overshoot around tight bends.
 */
export function smoothRoadCenterline(ctrl: P2[]): P2[] {
  if (ctrl.length < 2) return ctrl.map((p) => ({ ...p }));
  if (ctrl.length === 2) return sampleStraightLegacy(ctrl);

  let stable = ctrl.map((p) => ({ ...p }));
  for (let pass = 0; pass < 2; pass++) {
    const next = stable.map((p) => ({ ...p }));
    for (let i = 1; i < stable.length - 1; i++) {
      const prev = stable[i - 1], cur = stable[i], after = stable[i + 1];
      const beforeLength = Math.hypot(cur.x - prev.x, cur.z - prev.z);
      const afterLength = Math.hypot(after.x - cur.x, after.z - cur.z);
      if (beforeLength <= LOCAL_SMOOTH_SPAN && afterLength <= LOCAL_SMOOTH_SPAN) {
        next[i] = {
          x: prev.x * 0.25 + cur.x * 0.5 + after.x * 0.25,
          z: prev.z * 0.25 + cur.z * 0.5 + after.z * 0.25,
        };
      }
    }
    stable = next;
  }

  const out: P2[] = [];
  let cursor = stable[0];
  for (let i = 1; i < stable.length - 1; i++) {
    const prev = stable[i - 1], corner = stable[i], after = stable[i + 1];
    const inLength = Math.hypot(corner.x - prev.x, corner.z - prev.z);
    const outLength = Math.hypot(after.x - corner.x, after.z - corner.z);
    if (inLength < 1e-6 || outLength < 1e-6) continue;

    const inX = (corner.x - prev.x) / inLength;
    const inZ = (corner.z - prev.z) / inLength;
    const outX = (after.x - corner.x) / outLength;
    const outZ = (after.z - corner.z) / outLength;
    const turnCos = inX * outX + inZ * outZ;
    if (turnCos > 0.995) continue;

    const cut = Math.min(CORNER_RADIUS, inLength * 0.35, outLength * 0.35);
    const approach = { x: corner.x - inX * cut, z: corner.z - inZ * cut };
    const exit = { x: corner.x + outX * cut, z: corner.z + outZ * cut };
    appendLine(out, cursor, approach, true);

    const curveLength = Math.hypot(corner.x - approach.x, corner.z - approach.z)
      + Math.hypot(exit.x - corner.x, exit.z - corner.z);
    const steps = Math.max(2, Math.ceil(curveLength / SPACING));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const oneMinusT = 1 - t;
      out.push({
        x: oneMinusT * oneMinusT * approach.x + 2 * oneMinusT * t * corner.x + t * t * exit.x,
        z: oneMinusT * oneMinusT * approach.z + 2 * oneMinusT * t * corner.z + t * t * exit.z,
      });
    }
    cursor = exit;
  }
  appendLine(out, cursor, stable[stable.length - 1], true);
  out[0] = { ...ctrl[0] };
  out[out.length - 1] = { ...ctrl[ctrl.length - 1] };
  return out;
}

export function makeSampler(hf: Heightfield) {
  return (ctrl: P2[]): RoadSample[] => {
    const flat = smoothRoadCenterline(ctrl);

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

/**
 * Why a chain can't be committed, as a short player-facing HUD notice (already in the ticker's
 * uppercase field-office voice) — or null when the chain is valid. `validateChain` is this
 * function's boolean shadow; keep every rule in exactly one of the two by defining it here.
 * Checks run in the same order the player experiences them: a barely-there drag first, then
 * world bounds, then the land-endpoint rule (mid-chain water is fine — that's a bridge).
 */
export function explainChainRejection(ctrl: P2[], hf: Heightfield): string | null {
  if (ctrl.length < 2) return 'DRAG FURTHER TO SURVEY A ROAD';
  const lim = WORLD_SIZE / 2 - SNAP;
  for (const p of ctrl) {
    if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) return 'TOO CLOSE TO THE ISLAND EDGE';
  }
  if (!hf.isLand(ctrl[0].x, ctrl[0].z) || !hf.isLand(ctrl[ctrl.length - 1].x, ctrl[ctrl.length - 1].z)) {
    return 'ROADS MUST START AND END ON LAND';
  }
  return null;
}

export function validateChain(ctrl: P2[], hf: Heightfield): boolean {
  return explainChainRejection(ctrl, hf) === null;
}

/** Heading (radians) at `samples[i]`, via a forward/backward difference against its immediate
 * neighbors (clamped at the array ends) — the same convention `sampleAt` uses internally. Shared
 * by `BuildQueue` (Task 24's anisotropic terrain clamp, which needs each sample's own tangent
 * direction to keep clampBelow's "along the road" reach narrow) and `save.ts`'s restore path. */
export function sampleHeadingAt(samples: RoadSample[], i: number): number {
  const a = samples[Math.max(0, i - 1)];
  const b = samples[Math.min(samples.length - 1, i + 1)];
  return Math.atan2(b.z - a.z, b.x - a.x);
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

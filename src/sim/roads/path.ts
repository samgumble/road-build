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

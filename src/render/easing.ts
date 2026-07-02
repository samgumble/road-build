export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const damp = (cur: number, goal: number, lambda: number, dt: number) => cur + (goal - cur) * (1 - Math.exp(-lambda * dt));

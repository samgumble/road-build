export interface RainVisibility {
  fogNear: number;
  fogFar: number;
  sunScale: number;
}

export const RAIN_FOG_NEAR_FLOOR = 480;
export const RAIN_FOG_FAR_FLOOR = 720;
export const RAIN_SUN_SCALE_FLOOR = 0.65;

/** Pure weather readability curve. Rain can still compress depth and soften the key light, but
 * never far enough to hide the island-scale road network or flatten construction silhouettes. */
export function rainVisibility(rainAmount: number, baseFogNear: number, baseFogFar: number): RainVisibility {
  const rain = Math.max(0, Math.min(1, rainAmount));
  const denseNear = baseFogNear / 1.5;
  const denseFar = baseFogFar / 1.5;
  return {
    fogNear: baseFogNear + (Math.max(denseNear, Math.min(baseFogNear, RAIN_FOG_NEAR_FLOOR)) - baseFogNear) * rain,
    fogFar: baseFogFar + (Math.max(denseFar, Math.min(baseFogFar, RAIN_FOG_FAR_FLOOR)) - baseFogFar) * rain,
    sunScale: 1 + (RAIN_SUN_SCALE_FLOOR - 1) * rain,
  };
}

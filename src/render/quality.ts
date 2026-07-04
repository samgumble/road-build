export type RenderQuality = 'high' | 'low';

/**
 * Mobile heuristic: touch-capable AND a small viewport. Neither alone is a reliable signal
 * (desktop touchscreens exist; small windows on desktop are common), so both must hold.
 */
function isMobileLike(): boolean {
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) <= 820;
  return hasTouch && smallScreen;
}

function detectQuality(): RenderQuality {
  try {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('quality');
    if (override === 'high' || override === 'low') return override;
  } catch {
    // URLSearchParams unavailable in some test environments — fall through to heuristic.
  }
  return isMobileLike() ? 'low' : 'high';
}

/** Resolved once at module load: `?quality=` URL override, else a mobile UA/viewport heuristic. */
export const QUALITY: RenderQuality = detectQuality();

export const PIXEL_RATIO_CAP = QUALITY === 'high' ? 2 : 1.5;
export const SHADOW_MAP_SIZE = QUALITY === 'high' ? 2048 : 1024;

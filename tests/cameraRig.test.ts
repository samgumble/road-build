import { describe, expect, it } from 'vitest';
import { isEditableTarget, keyboardOrbitDelta } from '../src/input/cameraRig';

describe('CameraRig keyboard orbit actions', () => {
  it('maps held Q/E to equal and opposite frame-rate-independent yaw', () => {
    expect(keyboardOrbitDelta(true, false, 1)).toBeCloseTo(-keyboardOrbitDelta(false, true, 1), 8);
    const sixtyFrames = Array.from({ length: 60 }, () => keyboardOrbitDelta(true, false, 1 / 60))
      .reduce((sum, delta) => sum + delta, 0);
    expect(sixtyFrames).toBeCloseTo(keyboardOrbitDelta(true, false, 1), 8);
  });

  it('cancels when both actions are held and is inert when neither is held', () => {
    expect(keyboardOrbitDelta(true, true, 1)).toBe(0);
    expect(keyboardOrbitDelta(false, false, 1)).toBe(0);
  });

  it('protects text-entry controls from camera shortcuts', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'CANVAS', isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});

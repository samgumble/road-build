import { describe, expect, it } from 'vitest';
import {
  startScreenContent,
  isStartScreenActivationKey,
  shouldStartFromKeyboard,
} from '../src/ui/startScreen';

describe('start screen presentation model', () => {
  it('invites a fresh world to break ground', () => {
    expect(startScreenContent('amber-valley', false)).toEqual({
      eyebrow: 'ISLAND OPERATIONS',
      status: 'NEW SITE',
      primaryAction: 'BREAK GROUND',
      siteLine: 'AMBER VALLEY · READY FOR SURVEY',
    });
  });

  it('invites a returning world to continue its active site', () => {
    expect(startScreenContent('stone-summit', true)).toEqual({
      eyebrow: 'ISLAND OPERATIONS',
      status: 'ACTIVE SITE',
      primaryAction: 'CONTINUE SITE',
      siteLine: 'STONE SUMMIT · AUTOSAVE READY',
    });
  });

  it('normalizes seed punctuation for player-facing site names', () => {
    expect(startScreenContent('  misty__harbor--north  ', false).siteLine)
      .toBe('MISTY HARBOR NORTH · READY FOR SURVEY');
  });

  it('accepts Enter and Space without treating Escape as a start command', () => {
    expect(isStartScreenActivationKey('Enter')).toBe(true);
    expect(isStartScreenActivationKey(' ')).toBe(true);
    expect(isStartScreenActivationKey('Escape')).toBe(false);
  });

  it('yields Enter and Space to a focused secondary action', () => {
    expect(shouldStartFromKeyboard('Enter', false)).toBe(true);
    expect(shouldStartFromKeyboard('Enter', true)).toBe(false);
    expect(shouldStartFromKeyboard(' ', true)).toBe(false);
  });
});

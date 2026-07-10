import { describe, expect, it } from 'vitest';
import {
  constructionJobProgress,
  formatConstructionNotice,
  formatCrewTicker,
  formatSiteOverview,
} from '../src/ui/hud';

describe('formatSiteOverview', () => {
  it('turns live site metrics into a compact player-facing briefing', () => {
    expect(formatSiteOverview({
      roads: 7,
      scheduledJobs: 4,
      activeCrews: 3,
      cars: 12,
      homes: 8,
      buildings: 2,
      paused: false,
    })).toEqual([
      'NETWORK  7 ROADS',
      'WORK      3 CREWS · 4 JOBS',
      'TOWN      8 HOMES · 2 BUILDINGS',
      'TRAFFIC   12 CARS',
      'SIM       RUNNING',
    ]);
  });

  it('calls out a paused simulation', () => {
    expect(formatSiteOverview({
      roads: 0,
      scheduledJobs: 0,
      activeCrews: 0,
      cars: 0,
      homes: 0,
      buildings: 0,
      paused: true,
    }).at(-1)).toBe('SIM       PAUSED');
  });
});

describe('construction HUD polish', () => {
  it('summarizes pipelined build progress across survey and all four stages', () => {
    expect(constructionJobProgress({ surveyed: 1, graded: 0.5 }, false, 'graded', 0.5)).toBeCloseTo(0.3, 8);
    expect(constructionJobProgress({ surveyed: 1, graded: 1, gravel: 1, paved: 1, painted: 1 }, false, 'painted', 1)).toBe(1);
  });

  it('turns reverse stage position into forward demolition completion', () => {
    // Halfway backward through paved: painted is gone, half of paved remains, then gravel+graded.
    expect(constructionJobProgress({}, true, 'paved', 0.5)).toBeCloseTo(0.375, 8);
    expect(constructionJobProgress({}, true, 'graded', 0)).toBe(1);
  });

  it('labels active work, demolition, and breaks in player language', () => {
    expect(formatCrewTicker(0, 'gravel', false, false)).toBe('CREW 1 LAYING GRAVEL…');
    expect(formatCrewTicker(1, 'paved', true, false)).toBe('CREW 2 REMOVING ASPHALT…');
    expect(formatCrewTicker(2, 'graded', false, true)).toBe('CREW 3 ON BREAK');
  });

  it('reserves milestone notices for terminal construction events', () => {
    expect(formatConstructionNotice('painted', 0)).toBe('ROAD OPEN · CREW 1 COMPLETE');
    expect(formatConstructionNotice('removed', 2)).toBe('ROAD REMOVED · CREW 3 CLEAR');
    expect(formatConstructionNotice('gravel', 0)).toBeNull();
    expect(formatConstructionNotice('painted', -1)).toBeNull();
  });
});

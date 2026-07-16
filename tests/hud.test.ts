import { describe, expect, it } from 'vitest';
import {
  constructionJobProgress,
  formatConstructionNotice,
  formatCrewTicker,
  formatGrowthControl,
  formatSiteOverview,
  formatToolbarCollapse,
  UndoWindow,
  UNDO_WINDOW_MS,
  islandShareUrl,
} from '../src/ui/hud';

describe('islandShareUrl', () => {
  it('builds a canonical share link from the page URL and seed', () => {
    expect(islandShareUrl('https://samgumble.github.io/road-build/', 'amber-valley'))
      .toBe('https://samgumble.github.io/road-build/?seed=amber-valley');
  });
  it('replaces any existing query/hash rather than appending to it', () => {
    expect(islandShareUrl('https://samgumble.github.io/road-build/?seed=old-one#x', 'misty-ford'))
      .toBe('https://samgumble.github.io/road-build/?seed=misty-ford');
  });
  it('URL-encodes seeds that need it', () => {
    expect(islandShareUrl('http://localhost:5173/', 'two words'))
      .toBe('http://localhost:5173/?seed=two+words');
  });
});

describe('UndoWindow', () => {
  it('opens on a commit, stays open within the window, and expires after UNDO_WINDOW_MS', () => {
    const w = new UndoWindow();
    expect(w.isOpen(0)).toBe(false);
    w.open([3, 4], 1000);
    expect(w.isOpen(1000)).toBe(true);
    expect(w.isOpen(1000 + UNDO_WINDOW_MS - 1)).toBe(true);
    expect(w.isOpen(1000 + UNDO_WINDOW_MS)).toBe(false);
  });
  it('consume returns the committed edge ids exactly once, then closes', () => {
    const w = new UndoWindow();
    w.open([7], 0);
    expect(w.consume(10)).toEqual([7]);
    expect(w.isOpen(10)).toBe(false);
    expect(w.consume(10)).toEqual([]);
  });
  it('consume after expiry returns nothing', () => {
    const w = new UndoWindow();
    w.open([9], 0);
    expect(w.consume(UNDO_WINDOW_MS + 1)).toEqual([]);
  });
  it('a new commit replaces the previous window entirely (ids and deadline)', () => {
    const w = new UndoWindow();
    w.open([1], 0);
    w.open([2, 5], UNDO_WINDOW_MS); // second survey committed just as the first expires
    expect(w.consume(UNDO_WINDOW_MS + 10)).toEqual([2, 5]);
  });
  it('close() hides the window without consuming', () => {
    const w = new UndoWindow();
    w.open([1], 0);
    w.close();
    expect(w.isOpen(1)).toBe(false);
    expect(w.consume(1)).toEqual([]);
  });
});

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
      growthPaused: false,
      weather: 'overcast',
    })).toEqual([
      'NETWORK  7 ROADS',
      'WORK      3 CREWS · 4 JOBS',
      'TOWN      8 HOMES · 2 BUILDINGS',
      'TRAFFIC   12 CARS',
      'WEATHER   OVERCAST',
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
      growthPaused: true,
      weather: 'heavy-rain',
    }).at(-1)).toBe('SIM       PAUSED');
  });

  it('shows environment growth state independently from the global simulation state', () => {
    expect(formatSiteOverview({
      roads: 2,
      scheduledJobs: 0,
      activeCrews: 0,
      cars: 4,
      homes: 3,
      buildings: 1,
      paused: false,
      growthPaused: true,
      weather: 'clear',
    }).at(-1)).toBe('SIM       RUNNING · GROWTH PAUSED');
  });

  it('formats current coastal fog in the six-line briefing without adding a control', () => {
    const lines = formatSiteOverview({
      roads: 4,
      scheduledJobs: 0,
      activeCrews: 0,
      cars: 6,
      homes: 3,
      buildings: 1,
      paused: false,
      growthPaused: false,
      weather: 'coastal-fog',
    });

    expect(lines).toContain('WEATHER   COASTAL FOG');
    expect(lines).toHaveLength(6);
  });
});

describe('environment growth control', () => {
  it('uses explicit labels and feedback for both toggle states', () => {
    expect(formatGrowthControl(false)).toEqual({
      full: 'Growth',
      compact: 'GROW',
      notice: 'ENVIRONMENT GROWTH RESUMED',
    });
    expect(formatGrowthControl(true)).toEqual({
      full: 'Growth Paused',
      compact: 'GROW OFF',
      notice: 'ENVIRONMENT GROWTH PAUSED',
    });
  });
});

describe('toolbar collapse control', () => {
  it('keeps an explicit, accessible restore action in both states', () => {
    expect(formatToolbarCollapse(false)).toEqual({
      full: 'Hide Controls',
      compact: 'HIDE',
      title: 'Collapse site controls',
      expanded: true,
    });
    expect(formatToolbarCollapse(true)).toEqual({
      full: 'Show Controls',
      compact: 'TOOLS',
      title: 'Expand site controls',
      expanded: false,
    });
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

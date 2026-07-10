import { describe, expect, it } from 'vitest';
import { formatSiteOverview } from '../src/ui/hud';

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

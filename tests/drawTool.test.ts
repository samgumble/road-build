import { describe, it, expect } from 'vitest';
import { resolveDrawSnap } from '../src/input/drawTool';

// T41 review Finding 1 + 2: `resolveDrawSnap` is the pure decision behind the draw tool's
// close-the-loop cursor magnetism. It picks between the graph's own magnet-resolved point (e.g. an
// existing junction/mid-edge point) and the in-progress chain's own start point (closing a loop),
// deciding from the RAW cursor position rather than the already-resolved one so an unrelated
// existing node near the chain's start can no longer steal a legitimate junction snap.
describe('resolveDrawSnap', () => {
  const chainStart = { x: 0, z: 0 };

  it('(a) far from chain start: returns the magnet-resolved point unchanged', () => {
    const raw = { x: 100, z: 100 };
    const magnetResolved = { x: 100, z: 104 }; // e.g. snapped onto some nearby junction
    const result = resolveDrawSnap(raw, magnetResolved, chainStart, 4);
    expect(result).toEqual(magnetResolved);
  });

  it('(b) near chain start only (chain has >= 3 points): snaps to chain start', () => {
    const raw = { x: 1, z: 1 }; // within LOOP_CLOSE_RADIUS (6) of (0,0)
    const magnetResolved = { x: 40, z: 40 }; // magnetSnap found nothing nearby, fell back to grid snap far away
    const result = resolveDrawSnap(raw, magnetResolved, chainStart, 4);
    expect(result).toEqual(chainStart);
  });

  it('(c) PRIORITY: both chain start and an unrelated junction are within radius, junction is nearer to the raw cursor -> junction wins', () => {
    // Regression for Finding 1: an existing node K sits near the chain's start. The raw cursor is
    // closer to K than to the chain start. The old implementation measured distance from the
    // ALREADY-resolved point (which would already equal K here) back to chain start and snapped
    // onto chain start unconditionally within 6u — wrongly overriding a correct junction snap.
    const raw = { x: 5, z: 0 };
    const junctionK = { x: 5.5, z: 0 }; // magnetSnap's real answer: distance from raw = 0.5
    // chainStart (0,0): distance from raw = 5, which is still <= LOOP_CLOSE_RADIUS (6), so the old
    // code's "within 6u of chain start" check would have fired.
    const result = resolveDrawSnap(raw, junctionK, chainStart, 4);
    expect(result).toEqual(junctionK);
  });

  it('(d) both within radius, chain start nearer (or tied): chain start wins', () => {
    const raw = { x: 0.4, z: 0 };
    const junctionK = { x: 3, z: 0 }; // distance from raw = 2.6
    // chainStart (0,0): distance from raw = 0.4, nearer than junctionK.
    const result = resolveDrawSnap(raw, junctionK, chainStart, 4);
    expect(result).toEqual(chainStart);

    // Tie case: equal distances -> chain start wins (preserves easy loop closing when chain start
    // IS the magnet target, e.g. chain start was itself magnet-snapped onto a node at stroke start).
    const rawTie = { x: 1, z: 0 };
    const junctionTie = { x: 2, z: 0 }; // distance from rawTie = 1, same as chainStart's distance = 1
    const tieResult = resolveDrawSnap(rawTie, junctionTie, chainStart, 4);
    expect(tieResult).toEqual(chainStart);
  });

  it('(e) chain has fewer than 3 points: never loop-snaps, always returns magnet-resolved', () => {
    const raw = { x: 0, z: 0 }; // exactly on chain start
    const magnetResolved = { x: 40, z: 40 };
    expect(resolveDrawSnap(raw, magnetResolved, chainStart, 0)).toEqual(magnetResolved);
    expect(resolveDrawSnap(raw, magnetResolved, chainStart, 1)).toEqual(magnetResolved);
    expect(resolveDrawSnap(raw, magnetResolved, chainStart, 2)).toEqual(magnetResolved);
  });

  it('no-op when there is no active chain (chainStart null)', () => {
    const raw = { x: 0, z: 0 };
    const magnetResolved = { x: 40, z: 40 };
    expect(resolveDrawSnap(raw, magnetResolved, null, 0)).toEqual(magnetResolved);
  });
});

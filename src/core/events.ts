import type { Stage, V3, VehicleKind } from './types';

export interface GameEvents {
  'roads:changed': Record<string, never>;                     // any topology/stage change relevant to lanes+growth
  'roads:edgeAdded': { edgeId: number };
  'roads:edgeRemoved': { edgeId: number };
  'construction:stage': { edgeId: number; stage: Stage | 'removed'; crew: number };
  // `onBreak` (Task 33, additive): true while this crew is on its periodic work-rhythm break —
  // `t`/pos are stationary (frozen) for the break's duration; renderers can react (workers huddle
  // near the stockpile, vehicles idle) via this flag rather than inferring it from a lack of
  // position change.
  'construction:progress': { edgeId: number; stage: Stage; t: number; pos: V3; heading: number; vehicle: VehicleKind; demolish: boolean; crew: number; onBreak: boolean };
  'terrain:deformed': { minI: number; minJ: number; maxI: number; maxJ: number };
  // `id` (Task 35, additive): stable per-record id, monotonic within a GrowthSim instance and
  // persisted in saves — lets upgrade/stranded-decay events (below) reference a specific record
  // without relying on array position. Optional so pre-Task-35 callers/tests that construct this
  // payload by hand still type-check; consumers should treat a missing id defensively.
  'growth:spawn': { kind: 'tree' | 'field' | 'house' | 'building'; x: number; z: number; rot: number; id?: number };
  // Task 35: a house record upgraded in place to a building (same id, cell dev >= 1.35 with >= 2
  // developed neighbor cells). Renderer swaps the house instance for a building instance with a
  // pop animation; houseCount decrements. Fires at most once per record.
  'growth:upgrade': { id: number };
  // Task 35: a record has crossed the stranded-decay grace period (60 sim-s > 24u from any painted
  // road) and begins its ~30s fade-out. Additive — renderer starts the ease-down/sink animation;
  // the record is NOT removed yet (see `growth:remove` below, fired when the fade completes).
  'growth:stranded': { id: number };
  // Task 35: a stranded record's fade completed — the sim has deleted it from `GrowthSim.spawned`
  // and cleared the owning cell's spawnMask bits (regrowth becomes possible once re-roaded).
  // Renderer frees the instance slot; houseCount already decremented sim-side for house records.
  'growth:remove': { id: number };
  'atmosphere:phase': { night: boolean };
  // Task 31: ambient wilderness clearing. `indices` are positions into the WildernessTree[] array
  // the renderer/sim were both constructed with (stable per tree for the life of the world).
  'wilderness:cleared': { indices: number[] };
  // Task 34: quarry landmark placed (first road commit ever, or replayed on restore — see
  // src/sim/quarry.ts). Additive event; renderers build the pad+prop in response.
  'quarry:placed': { x: number; z: number; rot: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>();
  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as Handler<GameEvents[K]>)(payload));
  }
}

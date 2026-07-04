import type { Stage, V3, VehicleKind } from './types';

export interface GameEvents {
  'roads:changed': Record<string, never>;                     // any topology/stage change relevant to lanes+growth
  'roads:edgeAdded': { edgeId: number };
  'roads:edgeRemoved': { edgeId: number };
  'construction:stage': { edgeId: number; stage: Stage | 'removed'; crew: number };
  'construction:progress': { edgeId: number; stage: Stage; t: number; pos: V3; heading: number; vehicle: VehicleKind; demolish: boolean; crew: number };
  'terrain:deformed': { minI: number; minJ: number; maxI: number; maxJ: number };
  'growth:spawn': { kind: 'tree' | 'field' | 'house' | 'building'; x: number; z: number; rot: number };
  'atmosphere:phase': { night: boolean };
  // Task 31: ambient wilderness clearing. `indices` are positions into the WildernessTree[] array
  // the renderer/sim were both constructed with (stable per tree for the life of the world).
  'wilderness:cleared': { indices: number[] };
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

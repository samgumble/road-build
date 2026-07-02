import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/events';

describe('EventBus', () => {
  it('delivers payloads to subscribers and honors unsubscribe', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on('roads:edgeAdded', (e) => seen.push(e.edgeId));
    bus.emit('roads:edgeAdded', { edgeId: 1 });
    off();
    bus.emit('roads:edgeAdded', { edgeId: 2 });
    expect(seen).toEqual([1]);
  });
});

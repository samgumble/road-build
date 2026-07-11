import { describe, expect, it } from 'vitest';
import { vehicleGroundContacts } from '../src/render/constructionRenderer';
import { TRAFFIC_WEAR_OFFSETS } from '../src/render/roadRenderer';

describe('vehicle and roadway track patterns', () => {
  it('uses four wheel contacts for wheeled vehicles and two tread bands for tracked vehicles', () => {
    expect(vehicleGroundContacts('truck')).toHaveLength(4);
    expect(vehicleGroundContacts('liner')).toHaveLength(4);
    expect(vehicleGroundContacts('grader')).toHaveLength(6);
    expect(vehicleGroundContacts('excavator')).toHaveLength(2);
    expect(vehicleGroundContacts('paver')).toHaveLength(2);

    const excavator = vehicleGroundContacts('excavator');
    expect(excavator[0].lateral).toBeLessThan(0);
    expect(excavator[1].lateral).toBeGreaterThan(0);
  });

  it('renders two wheel paths for each traffic direction on a two-way roadway', () => {
    expect(TRAFFIC_WEAR_OFFSETS).toHaveLength(4);
    expect(TRAFFIC_WEAR_OFFSETS.filter((offset) => offset < 0)).toHaveLength(2);
    expect(TRAFFIC_WEAR_OFFSETS.filter((offset) => offset > 0)).toHaveLength(2);
    expect(TRAFFIC_WEAR_OFFSETS[0]).toBeCloseTo(-TRAFFIC_WEAR_OFFSETS[3], 6);
    expect(TRAFFIC_WEAR_OFFSETS[1]).toBeCloseTo(-TRAFFIC_WEAR_OFFSETS[2], 6);
  });
});

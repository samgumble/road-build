
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHorizonSkirt } from '../src/render/horizonSkirt';

describe('horizon skirt (world-edge softening)', () => {
  it('builds an inward-facing fog-range cylinder that never writes depth', () => {
    const skirt = buildHorizonSkirt();
    expect(skirt.name).toBe('horizon-skirt');

    const geometry = skirt.geometry as THREE.CylinderGeometry;
    expect(geometry.type).toBe('CylinderGeometry');
    // Beyond fog far (900) plus the camera's maximum orbit (620), so even the nearest wall is
    // fully fog-tinted and the player can never expose the cylinder's surface or fly through it.
    expect(geometry.parameters.radiusTop).toBeGreaterThan(1520);
    expect(geometry.parameters.radiusTop).toBeLessThan(1800);
    expect(geometry.parameters.openEnded).toBe(true);

    const material = skirt.material as THREE.MeshBasicMaterial;
    expect(material.side).toBe(THREE.BackSide); // camera sits inside the cylinder
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false); // must never occlude scene geometry in the depth buffer
    expect(material.fog).toBe(true); // the fog itself paints the band the right color
  });
});


import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHorizonSkirt } from '../src/render/horizonSkirt';

describe('horizon skirt (world-edge softening)', () => {
  it('builds an inward-facing fog-range cylinder that never writes depth', () => {
    const skirt = buildHorizonSkirt();
    expect(skirt.name).toBe('horizon-skirt');

    const geometry = skirt.geometry as THREE.CylinderGeometry;
    expect(geometry.type).toBe('CylinderGeometry');
    // inside the fog's far distance (900) so the fog fully tints it, but beyond the camera's
    // maximum orbit so the player can never fly through it
    expect(geometry.parameters.radiusTop).toBeGreaterThan(900 * 0.9);
    expect(geometry.parameters.radiusTop).toBeLessThan(1100);
    expect(geometry.parameters.openEnded).toBe(true);

    const material = skirt.material as THREE.MeshBasicMaterial;
    expect(material.side).toBe(THREE.BackSide); // camera sits inside the cylinder
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false); // must never occlude scene geometry in the depth buffer
    expect(material.fog).toBe(true); // the fog itself paints the band the right color
  });
});

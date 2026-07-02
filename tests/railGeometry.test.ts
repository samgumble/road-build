import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildRailBoxGeometry } from '../src/render/roadRenderer';

describe('buildRailBoxGeometry', () => {
  it('winds every triangle so its normal points away from the box interior', () => {
    const samples = [
      { x: 0, y: 5, z: 0 },
      { x: 4, y: 5, z: 0 },
      { x: 8, y: 5, z: 0 },
    ];
    const geo = buildRailBoxGeometry(samples, 2 /* offset toward +Z */, 0.4, 0.8, 0);

    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    expect(pos).toBeTruthy();
    expect(index).toBeTruthy();

    geo.computeBoundingBox();
    const bbox = geo.boundingBox!;
    const boxCenter = new THREE.Vector3();
    bbox.getCenter(boxCenter);

    const getVertex = (i: number) => new THREE.Vector3(pos!.getX(i), pos!.getY(i), pos!.getZ(i));

    let sawTopFace = false;
    let sawSideFace = false;
    const triCount = index!.count / 3;
    expect(triCount).toBeGreaterThan(0);

    for (let t = 0; t < triCount; t++) {
      const ia = index!.getX(t * 3);
      const ib = index!.getX(t * 3 + 1);
      const ic = index!.getX(t * 3 + 2);
      const a = getVertex(ia);
      const b = getVertex(ib);
      const c = getVertex(ic);

      const ab = b.clone().sub(a);
      const ac = c.clone().sub(a);
      const normal = ab.cross(ac).normalize();

      const centroid = a.clone().add(b).add(c).divideScalar(3);
      const outward = centroid.clone().sub(boxCenter);

      expect(normal.dot(outward)).toBeGreaterThan(0);

      if (normal.y > 0.9) sawTopFace = true;
      if (Math.abs(normal.z) > 0.9) sawSideFace = true;
    }

    expect(sawTopFace).toBe(true);
    expect(sawSideFace).toBe(true);
  });
});

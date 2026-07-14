import * as THREE from 'three';

/** Horizon skirt (polish pass): a huge inward-facing cylinder just inside the fog's far distance.
 * At that range the fog paints it entirely fog-colored, and its alpha map fades it out toward the
 * top — so the island's terrain/water edge dissolves into haze instead of ending like a table
 * edge when viewed from low angles. No per-frame color sync needed: the fog does the tinting. */
export function buildHorizonSkirt(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(950, 950, 320, 48, 1, true);
  const material = new THREE.MeshBasicMaterial({
    color: '#ffffff', // irrelevant — fully fog-mixed at this distance
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  // Vertical alpha gradient: opaque at the waterline, dissolving into the sky at the top.
  // (jsdom test environments have no 2d canvas — skip the map there; the mesh still works.)
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (canvas && ctx) {
    canvas.width = 1;
    canvas.height = 64;
    const gradient = ctx.createLinearGradient(0, 64, 0, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1, 64);
    const texture = new THREE.CanvasTexture(canvas);
    material.alphaMap = texture;
    material.map = texture;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'horizon-skirt';
  mesh.position.y = 100; // bottom dips below the waterline, top reaches into the sky band
  mesh.renderOrder = -1; // behind every transparent scene effect; depth still hides it correctly
  mesh.frustumCulled = false;
  return mesh;
}

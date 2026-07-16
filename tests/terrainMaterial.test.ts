import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { Heightfield } from '../src/sim/terrain/heightfield';

let TerrainRenderer: typeof import('../src/render/terrainRenderer').TerrainRenderer;
let terrainSurfaceColor: typeof import('../src/render/terrainRenderer').terrainSurfaceColor;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1280, innerHeight: 720 },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0 },
  });
  ({ TerrainRenderer, terrainSurfaceColor } = await import('../src/render/terrainRenderer'));
});

const ROCK = new THREE.Color('#8d8577');

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

describe('terrain material variation', () => {
  it('blends progressively toward rock as a slope steepens instead of snapping at one threshold', () => {
    const grass = terrainSurfaceColor(7, 0.2, 18, -24);
    const shoulder = terrainSurfaceColor(7, 0.55, 18, -24);
    const cliff = terrainSurfaceColor(7, 0.9, 18, -24);

    expect(colorDistance(grass, ROCK)).toBeGreaterThan(colorDistance(shoulder, ROCK));
    expect(colorDistance(shoulder, ROCK)).toBeGreaterThan(colorDistance(cliff, ROCK));
    expect(colorDistance(shoulder, grass)).toBeGreaterThan(0.01);
    expect(colorDistance(shoulder, cliff)).toBeGreaterThan(0.01);
  });

  it('adds deterministic, bounded macro color variation without texture allocations', () => {
    const first = terrainSurfaceColor(7, 0.2, 0, 0);
    const repeat = terrainSurfaceColor(7, 0.2, 0, 0);
    const distant = terrainSurfaceColor(7, 0.2, 84, -63);

    expect(first.getHex()).toBe(repeat.getHex());
    expect(colorDistance(first, distant)).toBeGreaterThan(0.005);
    expect(colorDistance(first, distant)).toBeLessThan(0.12);
  });

  it('keeps PBR lighting while injecting macro roughness variation into the terrain material', () => {
    const scene = new THREE.Scene();
    const renderer = new TerrainRenderer(scene, new Heightfield('terrain-material-test', new EventBus()), new EventBus());
    const material = renderer.mesh.material as THREE.MeshStandardMaterial;
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>',
    };

    material.onBeforeCompile(shader as never, {} as never);

    expect(material.roughness).toBeGreaterThan(0.85);
    expect(material.metalness).toBe(0);
    expect(shader.fragmentShader).toContain('roughnessFactor *=');
    expect(shader.fragmentShader).toContain('groundworkSeason');
  });
});

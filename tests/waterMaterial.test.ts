import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import { Heightfield } from '../src/sim/terrain/heightfield';

let TerrainRenderer: typeof import('../src/render/terrainRenderer').TerrainRenderer;
let waterReflectionMix: typeof import('../src/render/terrainRenderer').waterReflectionMix;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1280, innerHeight: 720 },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0 },
  });
  ({ TerrainRenderer, waterReflectionMix } = await import('../src/render/terrainRenderer'));
});

describe('water surface response', () => {
  it('adds more sky reflection at glancing angles and less on rough water', () => {
    const faceOn = waterReflectionMix(1, 0.65, 0.34);
    const middle = waterReflectionMix(0.65, 0.65, 0.34);
    const glancing = waterReflectionMix(0.25, 0.65, 0.34);
    const roughGlancing = waterReflectionMix(0.25, 0.9, 0.34);

    expect(faceOn).toBeCloseTo(0, 8);
    expect(middle).toBeGreaterThan(faceOn);
    expect(glancing).toBeGreaterThan(middle);
    expect(roughGlancing).toBeLessThan(glancing);
    expect(glancing).toBeLessThan(0.35);
  });

  it('passes world-space ripple normals and bounded reflection controls through the shader', () => {
    const renderer = new TerrainRenderer(
      new THREE.Scene(),
      new Heightfield('water-material-test', new EventBus()),
      new EventBus(),
    );
    const material = renderer.water.material as THREE.ShaderMaterial;

    expect(material.vertexShader).toContain('vWorldNormal');
    expect(material.fragmentShader).toContain('normalize(cameraPosition - vWorldPosition)');
    expect(material.fragmentShader).toContain('groundworkReflectionMix');
    expect(material.fragmentShader).toContain('smoothstep(0.0, 0.065');
    expect(material.uniforms.uReflectionStrength.value).toBeGreaterThan(0);
    expect(material.uniforms.uSurfaceRoughness.value).toBeGreaterThanOrEqual(0.6);
    expect(material.uniforms.uSurfaceRoughness.value).toBeLessThanOrEqual(0.85);
  });
});

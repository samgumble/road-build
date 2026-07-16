import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../src/core/events';
import {
  SceneryRenderer,
  installFieldWind,
  installTreeWind,
  weatherWindUniforms,
  type WeatherWindUniforms,
} from '../src/render/sceneryRenderer';
import { Heightfield } from '../src/sim/terrain/heightfield';

function fakeStandardShader(): {
  uniforms: Record<string, { value: number }>;
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>',
  };
}

describe('scenery living-weather shaders', () => {
  it('injects shared root-stable tree sway without replacing standard lighting', () => {
    const material = new THREE.MeshStandardMaterial();
    const uniforms = weatherWindUniforms();
    installTreeWind(material, uniforms);
    installTreeWind(material, uniforms);
    const shader = fakeStandardShader();

    material.onBeforeCompile(shader as never, {} as never);

    expect(shader.uniforms.uWeatherTime).toBe(uniforms.time);
    expect(shader.uniforms.uWeatherWind).toBe(uniforms.wind);
    expect(shader.vertexShader).toContain('groundworkTreeWind');
    expect(shader.vertexShader).toContain('groundworkHeight');
    expect(shader.vertexShader).toContain('#ifdef USE_INSTANCING');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.vertexShader.match(/uniform float uWeatherTime/g)).toHaveLength(1);

    const clone = material.clone();
    const cloneShader = fakeStandardShader();
    installTreeWind(clone, uniforms);
    clone.onBeforeCompile(cloneShader as never, {} as never);
    expect(cloneShader.uniforms.uWeatherWind).toBe(uniforms.wind);
    expect(cloneShader.vertexShader).toContain('groundworkTreeWind');
  });

  it('injects a non-negative world-phased field ripple with a distinct program key', () => {
    const treeMaterial = new THREE.MeshStandardMaterial();
    const fieldMaterial = new THREE.MeshStandardMaterial();
    const uniforms = weatherWindUniforms();
    installTreeWind(treeMaterial, uniforms);
    installFieldWind(fieldMaterial, uniforms);
    const shader = fakeStandardShader();

    fieldMaterial.onBeforeCompile(shader as never, {} as never);

    expect(shader.uniforms.uWeatherTime).toBe(uniforms.time);
    expect(shader.uniforms.uWeatherWind).toBe(uniforms.wind);
    expect(shader.vertexShader).toContain('groundworkFieldWorld');
    expect(shader.vertexShader).toContain('0.5 + 0.5 * sin');
    expect(shader.vertexShader).toContain('0.025');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(fieldMaterial.customProgramCacheKey()).not.toBe(treeMaterial.customProgramCacheKey());
  });

  it('updates one shared bounded wind scalar on a capped visual clock without touching instances', () => {
    const bus = new EventBus();
    const renderer = new SceneryRenderer(
      new THREE.Scene(),
      new Heightfield('weather-wind', bus),
      bus,
    );
    const internal = renderer as unknown as {
      weatherWind: WeatherWindUniforms;
      field: THREE.InstancedMesh;
      fieldStripe: THREE.InstancedMesh;
      park: THREE.InstancedMesh;
    };
    const before = renderer.instanceStats;
    const fieldVersion = internal.field.instanceMatrix.version;
    const stripeVersion = internal.fieldStripe.instanceMatrix.version;

    renderer.update(16, 0.8, 4);

    expect(renderer.instanceStats).toEqual(before);
    expect(internal.weatherWind.time.value).toBe(4);
    expect(internal.weatherWind.wind.value).toBeCloseTo(0.8);
    expect(internal.field.instanceMatrix.version).toBe(fieldVersion);
    expect(internal.fieldStripe.instanceMatrix.version).toBe(stripeVersion);
    expect((internal.field.material as THREE.Material).userData.groundworkWeatherWind).toBe('field');
    expect((internal.fieldStripe.material as THREE.Material).userData.groundworkWeatherWind).toBe('field');
    expect((internal.park.material as THREE.Material).userData.groundworkWeatherWind).toBeUndefined();

    renderer.update(0, 2, 0);
    expect(internal.weatherWind.wind.value).toBe(1);
    renderer.update(0, -1, 0);
    expect(internal.weatherWind.wind.value).toBe(0);

    const wrap = 20 * Math.PI;
    internal.weatherWind.time.value = wrap - 0.1;
    renderer.update(0, 0.5, 0.2);
    const wrappedTime = internal.weatherWind.time.value;
    expect(wrappedTime).toBeCloseTo(0.1, 10);
    expect(Math.sin(wrappedTime * 1.7)).toBeCloseTo(Math.sin((wrap + 0.1) * 1.7), 10);
    expect(Math.sin(wrappedTime * 2.1)).toBeCloseTo(Math.sin((wrap + 0.1) * 2.1), 10);
  });
});

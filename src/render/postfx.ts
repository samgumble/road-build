import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { PIXEL_RATIO_CAP } from './quality';
import { RESTRAINED_GRADE } from './colorGrade';

// Threshold tuned high (0.85) so daylight terrain/water/vertex-color surfaces — which sit well
// under 1.0 in linear-before-tonemap terms even under strong sun — do NOT bloom; only genuinely
// bright emissive/near-white pixels (headlights, lit windows, warning beacons at night) cross it.
// Verified via day/dusk/night screenshots (see task report) — day stays clean, night glows.
const BLOOM_THRESHOLD = 0.86;
const BLOOM_STRENGTH = 0.32;
const BLOOM_RADIUS = 0.4;

// VignetteShader mixes the frame toward vec3(1.0 - darkness) at the screen edges (Eskil's
// vignette) — that target is a MID-GRAY, not black, unless darkness is close to 1.0. An earlier
// tuning pass at darkness=0.55 produced a washed-out gray band at frame edges (very visible
// against a near-black night sky) because 1-0.55=0.45 is a fairly bright gray to mix toward.
// darkness=0.92 keeps the edge target near-black (0.08) for a subtle, conventional vignette; a
// smaller offset keeps dot(uv,uv) from reaching the target strength except right at the corners.
const VIGNETTE_OFFSET = 0.9;
const VIGNETTE_DARKNESS = 0.92;

const RESTRAINED_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: RESTRAINED_GRADE.saturation },
    uContrast: { value: RESTRAINED_GRADE.contrast },
    uWarmth: { value: RESTRAINED_GRADE.warmth },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarmth;
    varying vec2 vUv;
    void main() {
      vec4 sampleColor = texture2D(tDiffuse, vUv);
      float luma = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 graded = mix(vec3(luma), sampleColor.rgb, uSaturation);
      graded = (graded - 0.5) * uContrast + 0.5;
      graded += vec3(uWarmth, uWarmth * 0.15, -uWarmth * 0.65);
      gl_FragColor = vec4(clamp(graded, 0.0, 1.0), sampleColor.a);
    }
  `,
};

export interface PostFx {
  composer: EffectComposer;
  render: () => void;
  setSize: (w: number, h: number) => void;
}

/**
 * High-tier only. Builds an EffectComposer with subtle bloom (night lights/beacons/windows glow;
 * day stays clean at this threshold) and a gentle vignette, finished with OutputPass so tone
 * mapping + sRGB output conversion happen exactly once.
 *
 * Double-tonemapping pitfall (hit and fixed during this task — see task report for before/after
 * night-sky screenshots): WebGLRenderer bakes `renderer.toneMapping` into every standard
 * material's fragment shader, so RenderPass's plain `renderer.render()` call already applies ACES
 * once while the renderer's own toneMapping stays set. Layering `OutputPass` on top applies the
 * SAME curve a second time (it reads `renderer.toneMapping` live, at its own render() call each
 * frame), crushing contrast into a washed-out gray — most visible on the near-black night sky.
 *
 * Fix: keep `renderer.toneMapping` at NoToneMapping for the whole composer chain (so RenderPass
 * and bloom always see/operate on un-tonemapped linear data), but swap it back to the real curve
 * for the single frame-slice where OutputPass itself runs, then immediately restore NoToneMapping.
 * Passes execute synchronously in `composer.render()`, so this works: RenderPass/bloom run first
 * against NoToneMapping, then OutputPass runs last against the real curve, and nothing outside
 * `render()` below ever observes the real value being set (so no other code needs to know).
 *
 * (An earlier attempt used a hand-rolled `ShaderPass(OutputShader)` instead of `OutputPass` to
 * sidestep this — that failed differently: `OutputShader`'s vertex shader declares
 * `modelViewMatrix`/`projectionMatrix`/`position`/`uv`, which is correct for the `RawShaderMaterial`
 * `OutputPass` uses internally, but `ShaderPass` wraps shaders in a plain `ShaderMaterial`, which
 * auto-injects those same declarations — a redefinition compile error, silently rendering nothing.
 * `OutputPass` is the right tool; it just needs the toneMapping-timing fix above.)
 *
 * Low tier skips all of this — main.ts calls renderer.render(scene, camera) directly instead,
 * where the renderer's own single tonemapping pass is exactly correct.
 */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostFx {
  const realToneMapping = renderer.toneMapping;

  // EffectComposer's default render target has no MSAA (`samples` unset), unlike the main canvas
  // (created with antialias:true) — supplying our own target with `samples` set restores
  // antialiasing quality parity with the low-tier direct-render path.
  const pixelRatio = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
  const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth * pixelRatio,
    window.innerHeight * pixelRatio,
    { samples: 4 },
  );

  const composer = new EffectComposer(renderer, renderTarget);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  );
  composer.addPass(bloomPass);

  const vignettePass = new ShaderPass(VignetteShader);
  vignettePass.uniforms.offset.value = VIGNETTE_OFFSET;
  vignettePass.uniforms.darkness.value = VIGNETTE_DARKNESS;
  composer.addPass(vignettePass);

  // A nearly neutral high-tier grade unifies terrain, water, and sky after bloom/vignette while
  // retaining gameplay hue separation. Low tier skips the composer and therefore this pass.
  composer.addPass(new ShaderPass(RESTRAINED_GRADE_SHADER));

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // Keep the renderer at NoToneMapping at rest (so RenderPass/bloom, which run first each frame,
  // never bake the curve in), and wrap ONLY OutputPass's own render() to briefly restore the real
  // curve for the instant OutputPass reads renderer.toneMapping — then put NoToneMapping straight
  // back before returning control to the composer's pass loop. This is narrower than toggling
  // around the whole composer.render() call (which would also affect RenderPass/bloom, since they
  // run before OutputPass in the same call).
  renderer.toneMapping = THREE.NoToneMapping;
  const originalOutputRender = outputPass.render.bind(outputPass);
  outputPass.render = (...args: Parameters<typeof originalOutputRender>) => {
    renderer.toneMapping = realToneMapping;
    originalOutputRender(...args);
    renderer.toneMapping = THREE.NoToneMapping;
  };

  return {
    composer,
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
    },
  };
}

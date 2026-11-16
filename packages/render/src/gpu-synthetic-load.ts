import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { createEngineDrawingState, restoreEngineDrawingState, saveEngineDrawingState } from "./engine-drawing-state";

/**
 * The GPU probe's synthetic load (`gpuprobe serial`, `gpu-frame-probe.ts`): a fixed amount of fragment arithmetic that
 * touches no scene resource, so its time moves only with the GPU's own speed (its clock and thermal state), never with
 * the frame's passes, targets or their history. A step in which it doubles says the device slowed down as a whole.
 *
 * One draw covers a private 256 x 256 target; every fragment runs `SYNTHETIC_LOAD_ITERATIONS` rounds of a sine and a
 * fract, each fed by the round before and bounded by a uniform, so a compiler can neither unroll nor fold the loop. It
 * is drawn through Babylon (`EffectRenderer`), so the Engine's state cache stays valid.
 */

/** Rounds per fragment. Tune so one draw takes about 2 ms on an RTX 2060. */
export const SYNTHETIC_LOAD_ITERATIONS = 1024;
/** The loop's compile-time bound: GLSL ES 1 wants a constant one, and the uniform ends it. */
const MAX_ITERATIONS = 16384;
const SIZE = 256;
const SHADER = "hapticGpuSyntheticLoad";

ShaderStore.ShadersStore[`${SHADER}VertexShader`] = "attribute vec2 position;\nvoid main(void) {\ngl_Position = vec4(position, 0.0, 1.0);\n}";
// loadParams = (iterations, seed).
ShaderStore.ShadersStore[`${SHADER}PixelShader`] = `precision highp float;
uniform vec2 loadParams;
void main(void) {
  float value = fract(gl_FragCoord.x * 0.0131 + gl_FragCoord.y * 0.0173 + loadParams.y);
  for (int index = 0; index < ${MAX_ITERATIONS}; index++) {
    if (float(index) >= loadParams.x) break;
    value = fract(sin(value * 12.9898 + float(index) * 0.001) * 43758.5453 + value);
  }
  gl_FragColor = vec4(value, value, value, 1.0);
}`;

const drawingState = createEngineDrawingState();

export interface GpuSyntheticLoad {
  /** Whether its program has compiled; asking starts the compile. */
  ready(): boolean;
  /** One draw of the load into its own target; the Engine's drawing state is as before afterwards. */
  draw(): void;
  dispose(): void;
}

/** The Engine's synthetic load; its program and target are made at the first `ready()`. */
export function createGpuSyntheticLoad(engine: AbstractEngine, iterations = SYNTHETIC_LOAD_ITERATIONS): GpuSyntheticLoad {
  let effect: EffectWrapper | null = null;
  let renderer: EffectRenderer | null = null;
  let target: RenderTargetWrapper | null = null;
  let draws = 0;
  const make = () => {
    effect ??= new EffectWrapper({
      engine, name: SHADER, vertexShader: SHADER, fragmentShader: SHADER, useShaderStore: true, shaderLanguage: 0,
      uniformNames: ["loadParams"], samplerNames: [],
    });
    renderer ??= new EffectRenderer(engine);
    target ??= engine.createRenderTargetTexture({ width: SIZE, height: SIZE }, {
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false,
      type: Constants.TEXTURETYPE_UNSIGNED_BYTE, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      label: SHADER,
    });
    return effect;
  };
  return {
    ready: () => make().isReady(),
    draw: () => {
      const wrapper = make();
      if (!wrapper.isReady() || !renderer || !target) return;
      saveEngineDrawingState(engine, drawingState);
      try {
        engine.setAlphaMode(Constants.ALPHA_DISABLE);
        engine.setColorWrite(true);
        engine.bindFramebuffer(target, 0, undefined, undefined, true);
        renderer.applyEffectWrapper(wrapper);
        // A new seed each draw: no driver can reuse the last result.
        wrapper.effect.setFloat2("loadParams", iterations, (draws++ % 97) / 97);
        renderer.draw();
        engine.unBindFramebuffer(target, true);
      } finally {
        restoreEngineDrawingState(engine, drawingState);
      }
    },
    dispose: () => {
      effect?.dispose();
      renderer?.dispose();
      target?.dispose();
      effect = renderer = target = null;
    },
  };
}

import { afterEach, describe, expect, it } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { AlphaState } from "@babylonjs/core/States/alphaCullingState";
import {
  beginPremultipliedLayerContent, endPremultipliedLayerContent, followLayerMultiplyAlphaMode, isTargetedLayerScene,
  layerMultiplyAlphaMode, setTargetedLayerScene,
} from "./layer-composite";

type Rgba = [number, number, number, number];

/** One blended write into an RGBA8 target, by the factors Babylon sets for `mode` (its own table). */
function blend(mode: number, source: Rgba, destination: Rgba): Rgba {
  const state = new AlphaState(false) as unknown as { setAlphaMode(mode: number, target: number): void; _blendFunctionParameters: number[]; _blendEquationParameters: number[] };
  state.setAlphaMode(mode, 0);
  const [srcRgb, dstRgb, srcAlpha, dstAlpha] = state._blendFunctionParameters.slice(0, 4) as [number, number, number, number];
  // Every mode here adds its two terms (FUNC_ADD).
  expect(state._blendEquationParameters[0] ?? 32774).toBe(32774);
  const factor = (name: number, channel: number): number => {
    switch (name) {
      case 0: return 0;
      case 1: return 1;
      case 768: return source[channel]!;
      case 769: return 1 - source[channel]!;
      case 770: return source[3];
      case 771: return 1 - source[3];
      case 772: return destination[3];
      case 773: return 1 - destination[3];
      case 774: return destination[channel]!;
      case 775: return 1 - destination[channel]!;
      default: throw new Error(`Unexpected blend factor ${name}`);
    }
  };
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return source.map((value, channel) => {
    const [src, dst] = channel < 3 ? [srcRgb, dstRgb] : [srcAlpha, dstAlpha];
    return clamp(value * factor(src, channel) + destination[channel]! * factor(dst, channel));
  }) as Rgba;
}

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value, `channel ${index}`).toBeCloseTo(expected[index]!, 6));
}

const engines: NullEngine[] = [];
afterEach(() => { while (engines.length) engines.pop()!.dispose(); });

function scene(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

describe("Scene Layer composite", () => {
  it("multiplies what is beneath a direct layer by the factor and keeps its alpha", () => {
    // LayerMultiplyBlock writes (f, 0) on a direct layer.
    close(blend(layerMultiplyAlphaMode(false), [1, 0.5, 0.25, 0], [0.4, 0.6, 0.8, 1]), [0.4, 0.3, 0.2, 1]);
  });

  it("darkens a post-processed layer's target, and what shows through it, by the grey once composited", () => {
    // Premultiplied content (0.2, 0.1, 0.05) at coverage 0.4, then a grey Multiply of g = 0.6: (0, 0, 0, 1 − g).
    const darkened = blend(layerMultiplyAlphaMode(true), [0, 0, 0, 0.4], [0.2, 0.1, 0.05, 0.4]);
    close(darkened, [0.12, 0.06, 0.03, 0.64]);
    // Over a world of (0.5, 0.7, 0.9): g × (content + world × (1 − coverage)) = 0.6 × (0.5, 0.52, 0.59).
    close(blend(Constants.ALPHA_PREMULTIPLIED, darkened, [0.5, 0.7, 0.9, 1]).slice(0, 3), [0.3, 0.312, 0.354]);
  });

  it("stores ordinary blending premultiplied with its coverage, which the blit composites as a direct layer would draw", () => {
    const world: Rgba = [0.5, 0.5, 0.5, 1];
    const visuals: Rgba[] = [[1, 1, 1, 0.5], [0, 0.2, 1, 0.5]];
    // Straight onto the world, as a direct layer draws.
    const direct = visuals.reduce((under, visual) => blend(Constants.ALPHA_COMBINE, visual, under), world);
    close(direct.slice(0, 3), [0.375, 0.475, 0.875]);
    // Into a target cleared to (0, 0, 0, 0), then the blit.
    const target = visuals.reduce((under, visual) => blend(Constants.ALPHA_LAYER_ACCUMULATE, visual, under), [0, 0, 0, 0] as Rgba);
    close(target, [0.25, 0.35, 0.75, 0.75]);
    close(blend(Constants.ALPHA_PREMULTIPLIED, target, world).slice(0, 3), direct.slice(0, 3));
    // Additive over an empty part of the target adds its colour and keeps the coverage, so the blit adds it too.
    const glow = blend(Constants.ALPHA_ADD, [0.4, 0.4, 0.4, 1], [0, 0, 0, 0]);
    close(glow, [0.4, 0.4, 0.4, 0]);
    close(blend(Constants.ALPHA_PREMULTIPLIED, glow, world).slice(0, 3), [0.9, 0.9, 0.9]);
  });

  it("premultiplies only ordinary blending, only between begin and end", () => {
    const engine = new NullEngine();
    engines.push(engine);
    engine.setAlphaMode(Constants.ALPHA_COMBINE);
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_COMBINE);
    beginPremultipliedLayerContent(engine);
    engine.setAlphaMode(Constants.ALPHA_COMBINE);
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_LAYER_ACCUMULATE);
    for (const mode of [Constants.ALPHA_ADD, Constants.ALPHA_DISABLE, Constants.ALPHA_PREMULTIPLIED_PORTERDUFF, Constants.ALPHA_MULTIPLY]) {
      engine.setAlphaMode(mode);
      expect(engine.getAlphaMode(), String(mode)).toBe(mode);
    }
    endPremultipliedLayerContent(engine);
    engine.setAlphaMode(Constants.ALPHA_COMBINE);
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_COMBINE);
    // A second bracket reuses the one hook.
    beginPremultipliedLayerContent(engine);
    engine.setAlphaMode(Constants.ALPHA_COMBINE);
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_LAYER_ACCUMULATE);
    endPremultipliedLayerContent(engine);
  });

  it("blends a Multiply Material by its Scene's layer kind at every draw and ignores writes", () => {
    const host = scene();
    const other = new Scene(host.getEngine());
    const material = new StandardMaterial("multiply", host);
    const untouched = new StandardMaterial("translucent", host);
    followLayerMultiplyAlphaMode(material);
    expect(isTargetedLayerScene(host)).toBe(false);
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    setTargetedLayerScene(host, true);
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    material.alphaMode = Constants.ALPHA_COMBINE;
    expect(material.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF);
    expect(untouched.alphaMode).toBe(Constants.ALPHA_COMBINE);
    expect(isTargetedLayerScene(other)).toBe(false);
    setTargetedLayerScene(host, false);
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
  });
});

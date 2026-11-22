import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { ThinSSRBlurPostProcess } from "@babylonjs/core/PostProcesses/thinSSRBlurPostProcess";
import { ambientOcclusionBlurShader } from "./ambient-occlusion-shader";
import { pairedBlurShader, REFLECTION_BLUR_SHADER, reflectionBlurOffset, reflectionBlurSource } from "./paired-blurs";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

const BABYLON = ShaderStore.ShadersStore[REFLECTION_BLUR_SHADER]!;

it("keeps the ambient occlusion blur's own pass text as it was before the blur was split into parts", () => {
  // The digest of the text the separate passes compiled before `ambientOcclusionBlurSource` existed: the separate path
  // must stay byte-identical, so its program, and the bytes the paired pass is compared with, are unchanged.
  const text = ambientOcclusionBlurShader();
  expect(text).toHaveLength(660);
  expect(createHash("sha256").update(text).digest("hex")).toBe("b6c96617ee0cdf10c66e2b9b2013944baa9b358ae8edbafc0a9ac43c782a634d");
});

it("derives a paired program whose main neither returns, discards nor writes gl_FragColor, with one output per blur", () => {
  const fragment = pairedBlurShader();
  expect([...fragment.matchAll(/layout\(location = (\d)\) out vec4 (\w+);/g)].map(([, location, name]) => `${location}:${name}`))
    .toEqual(["0:hapticBlurReflection", "1:hapticBlurOcclusion"]);
  expect(fragment).not.toMatch(/gl_FragColor|gl_FragData|\breturn\b|\bdiscard\b/);
  const main = fragment.slice(fragment.indexOf("void main() {"));
  expect(main.split("{").length).toBe(main.split("}").length);
  // One vUV, one global weights array (the occlusion blur's main keeps its local `weights`).
  expect(fragment.match(/varying vec2 vUV;/g)).toHaveLength(1);
  expect(fragment).not.toMatch(/const float weights\[/);
});

it("derives the paired program the native proof compared, from the Babylon release the repository pins", () => {
  // The digest of the program `e2e/paired-blurs.spec.ts` proved byte-identical on a native GPU: any change to Babylon's
  // reflection blur that the counted replacements still accept (a weight, a tap) changes it and fails here.
  const text = pairedBlurShader();
  expect([text.length, createHash("sha256").update(text).digest("hex")]).toEqual([3009, "0f6736d5fc300de4a72d77904305d55dae77e164f115d52c772b3be48e0d17ce"]);
});

it("holds Babylon's reflection taps, their weights and their order verbatim", () => {
  const fragment = pairedBlurShader();
  // Main's taps, from the blur radius to the last tap.
  const taps = BABYLON.slice(BABYLON.indexOf("float blurRadius"), BABYLON.indexOf("gl_FragColor=vec4(accumulator"));
  expect(taps).toContain("processSample(vUV,-1.0*2.0,stepSize,accumulator,denominator);");
  expect(fragment).toContain(taps);
  // The tap function and the weights, only their array renamed.
  const helper = BABYLON.slice(BABYLON.indexOf("const float weights[8]"), BABYLON.indexOf("void main()"));
  expect(fragment).toContain(helper.replaceAll("weights[", "hapticReflectionBlurWeights["));
  expect(fragment).toContain("if (dot(colorFull,vec4(1.0))==0.0) {hapticBlurReflection=colorFull;} else {");
});

it.each([
  ["the varying", "varying vec2 vUV;"],
  ["the weights", "weights["],
  ["the early end", "{gl_FragColor=colorFull;return;}"],
  ["the last write", "gl_FragColor=vec4("],
  ["main", "void main()"],
])("throws when Babylon's reflection blur changes %s", (_name, pattern) => {
  expect(() => reflectionBlurSource(BABYLON.replace(pattern, "changed"))).toThrow(/reflection blur shader/);
});

it("throws when a pattern is found more often than the derivation expects", () => {
  expect(() => reflectionBlurSource(BABYLON.replace("varying vec2 vUV;", "varying vec2 vUV;varying vec2 vUV;"))).toThrow(/2 times, not 1/);
});

it("computes the reflection offset as Babylon's blur binds it, to the last bit", async () => {
  const engine = new NullEngine();
  disposers.push(() => engine.dispose());
  for (const direction of [new Vector2(1, 0), new Vector2(0, 1)]) {
    const blur = new ThinSSRBlurPostProcess("blur", engine, direction, 0.03);
    disposers.push(() => blur.dispose());
    // Babylon creates the Effect once its shader import resolves.
    await vi.waitFor(() => expect(blur.drawWrapper.effect).not.toBeNull());
    const effect = blur.drawWrapper.effect!;
    // Recorded, not applied: NullEngine's Effect has no compiled program to set them on.
    const set = vi.spyOn(effect, "setFloat2").mockImplementation(() => effect);
    // Sizes where (1 / w) * 0.03 and 0.03 / w round differently, so a reordered formula fails.
    for (const [width, height] of [[1000, 3], [313, 7], [362, 13]]) {
      blur.textureWidth = width!;
      blur.textureHeight = height!;
      set.mockClear();
      blur.bind();
      const bound = set.mock.calls.find(([name]) => name === "texelOffsetScale")!;
      expect(reflectionBlurOffset(width!, height!, direction)).toEqual([bound[1], bound[2]]);
    }
  }
});

import type { Effect } from "@babylonjs/core/Materials/effect";
import { PreProcess } from "@babylonjs/core/Engines/Processors/shaderProcessor";

/**
 * `effect`'s fragment source as a WebGL2 context compiles it: Babylon's own preprocessor evaluates its `#if` branches
 * against the Effect's defines, as Babylon's WebGL2 shader processor does. The headless Engine has no shader
 * processor and keeps every branch, so a check of what a program can do (`discard`) reads this.
 */
export function preprocessedFragment(effect: Effect): string {
  let processed: string | null = null;
  PreProcess(effect.fragmentSourceCode, {
    defines: effect.defines.split("\n"),
    indexParameters: {},
    isFragment: true,
    shouldUseHighPrecisionShader: true,
    supportsUniformBuffers: true,
    shadersRepository: "",
    includesShadersStore: {},
    processor: null,
    version: "300",
    platformName: "WEBGL2",
    processingContext: null,
    isNDCHalfZRange: false,
    useReverseDepthBuffer: false,
  }, (code) => { processed = code; }, effect.getEngine());
  if (processed === null) throw new Error(`The fragment source of ${String(effect.name)} did not preprocess synchronously`);
  return processed;
}

/** Whether the program `effect` compiles to can `discard` a fragment. */
export function fragmentCanDiscard(effect: Effect): boolean {
  return /\bdiscard\b/.test(preprocessedFragment(effect));
}

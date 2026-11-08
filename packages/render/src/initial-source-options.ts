import type { CreateEngineOptions } from "./create-engine-types";

/** The options that carry a view's initial source data: its first source lease, which Play releases on a Change Scene. */
const INITIAL_SOURCE_OPTIONS = [
  "textureBytes", "modelBytes", "modelSources", "modelPayloads", "spritePayloads", "spriteAnimations",
  "tilemapPayloads", "tilesetPayloads", "waterPayloads", "fontFacetypeBytes", "fontMsdfJson", "fontMsdfPng",
  "fontCssStackByGuid", "fontFaceEntries", "materialDocuments", "materialFunctions", "audioLibrary", "particleLibrary",
  "renderTargets", "renderTargetTextures", "areaEmissions", "texturePixelSizes", "modelClipAnimationGuids",
  "retargetAnimationLoads", "navmeshBytes", "audioReverbBytes", "audioBytes", "spawnableLights",
] as const satisfies readonly (keyof CreateEngineOptions)[];

/** A view's own options copy must not keep its initial source data alive after that lease is released. */
export function releaseInitialSourceOptions(options: CreateEngineOptions): void {
  for (const key of INITIAL_SOURCE_OPTIONS) delete options[key];
}

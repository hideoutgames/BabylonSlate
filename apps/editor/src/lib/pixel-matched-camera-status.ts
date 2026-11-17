import {
  pixelMatchedCameras,
  pixelMatchedDesignFrame,
  sceneLayerDesignResolution,
  type ProjectDocument,
} from "@haptic/core";

/** The project's pixel-matched camera framing (Pixel-Perfect Mode with Nearest Texture Filtering), or null. */
export type PixelMatchedCameraLens = { design: { width: number; height: number }; pixelsPerUnit: number };

export function projectPixelMatchedLens(project: ProjectDocument | null | undefined): PixelMatchedCameraLens | null {
  if (!project || !pixelMatchedCameras(project.settings.twoD)) return null;
  return { design: sceneLayerDesignResolution(project.settings.render), pixelsPerUnit: project.settings.twoD.pixelsPerUnit };
}

/** The tooltip of a size row a pixel-matched camera rounds. */
export const PIXEL_MATCHED_SIZE_HINT =
  "Pixel-Perfect Mode with Nearest Texture Filtering rounds this to the nearest whole number of design pixels per texture pixel.";

/** What a pixel-matched camera framing `requestedHeight` units over the design area resolves to, for a row's status. */
export function pixelMatchedSizeStatus(requestedHeight: number, lens: PixelMatchedCameraLens): string {
  const frame = pixelMatchedDesignFrame(requestedHeight, lens);
  const scale = frame.scale >= 1 ? `${frame.scale}` : `1/${Math.round(1 / frame.scale)}`;
  return `Pixel-matched: ${scale} design pixels per texel, ${Number(frame.height.toFixed(3))} units tall.`;
}

import { Texture, type BaseTexture } from "@babylonjs/core";
import { isEngineOwnedGpuTexture } from "./gpu-resource-live";

export interface PixelPerfectSettings {
  pixelsPerUnit: number;
  /** Project flag; editor pinch and wheel stay continuous regardless. */
  integerZoomSteps: boolean;
}

/**
 * Half-height of the orthographic frustum that makes one texture pixel cover
 * exactly one device pixel: the canvas height in pixels divided by the
 * authoring scale, halved.
 */
export function pixelPerfectOrthoHalfHeight(
  canvasHeightPx: number,
  pixelsPerUnit: number,
  zoom = 1,
): number {
  if (canvasHeightPx <= 0 || pixelsPerUnit <= 0 || zoom <= 0) return 1;
  return canvasHeightPx / pixelsPerUnit / 2 / zoom;
}

/**
 * Nearest integer zoom factor, so sprites scale by whole pixels. Zooming out
 * uses `1/n` rather than clamping to 1, which would make zoom-out impossible.
 */
export function quantizeZoom(zoom: number): number {
  if (zoom <= 0) return 1;
  if (zoom >= 1) return Math.max(1, Math.round(zoom));
  const inverse = Math.max(1, Math.round(1 / zoom));
  return 1 / inverse;
}

/** Snap a world coordinate to the device pixel grid at the authoring scale. */
export function snapToPixelGrid(value: number, pixelsPerUnit: number): number {
  if (pixelsPerUnit <= 0) return value;
  return Math.round(value * pixelsPerUnit) / pixelsPerUnit;
}

export function snapPointToPixelGrid(
  point: { x: number; y: number; z: number },
  pixelsPerUnit: number,
): { x: number; y: number; z: number } {
  return {
    x: snapToPixelGrid(point.x, pixelsPerUnit),
    y: snapToPixelGrid(point.y, pixelsPerUnit),
    // Z is depth in 2D, not a screen axis, so it stays untouched.
    z: point.z,
  };
}

/**
 * Nearest sampling with mipmaps off and no wrap bleed: the sampling setup a
 * pixel-art project needs, applied to an already-loaded texture.
 */
export function applyPixelArtSampling(texture: BaseTexture): void {
  texture.updateSamplingMode?.(Texture.NEAREST_SAMPLINGMODE);
  const editable = texture as BaseTexture & {
    wrapU?: number;
    wrapV?: number;
    anisotropicFilteringLevel?: number;
  };
  editable.wrapU = Texture.CLAMP_ADDRESSMODE;
  editable.wrapV = Texture.CLAMP_ADDRESSMODE;
  editable.anisotropicFilteringLevel = 1;
}

/**
 * Walk every texture currently registered on a Babylon scene and apply
 * pixel-art sampling. Call when pixel-perfect mode turns on (and after
 * textures load into a pixel-perfect project) so nearest filtering is not
 * left as a dead helper.
 */
export function applyPixelArtSamplingToScene(scene: {
  textures: BaseTexture[];
}): void {
  for (const texture of scene.textures) {
    if (isEngineOwnedGpuTexture(texture)) continue;
    applyPixelArtSampling(texture);
  }
}

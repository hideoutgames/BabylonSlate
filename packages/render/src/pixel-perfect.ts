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

/** Snap a world coordinate to the device pixel grid at the authoring scale. */
export function snapToPixelGrid(value: number, pixelsPerUnit: number): number {
  if (pixelsPerUnit <= 0) return value;
  return Math.round(value * pixelsPerUnit) / pixelsPerUnit;
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

function modelAlbedoTextures(
  materials: readonly object[] | undefined,
): Set<BaseTexture> {
  const found = new Set<BaseTexture>();
  if (!materials) return found;
  const slots = [
    "albedoTexture",
    "emissiveTexture",
    "bumpTexture",
    "metallicTexture",
    "reflectivityTexture",
    "ambientTexture",
  ] as const;
  for (const material of materials) {
    const record = material as Record<string, unknown>;
    for (const slot of slots) {
      const texture = record[slot];
      if (texture && typeof texture === "object") {
        found.add(texture as BaseTexture);
      }
    }
  }
  return found;
}

/**
 * Walk scene-owned textures that are not model/GLB construction albedos.
 * ResourceCache (engine-owned) wrappers are skipped — sprite/tilemap use a
 * dedicated NEAREST / no-mip cache key instead of mutating a 3D albedo.
 */
export function applyPixelArtSamplingToScene(scene: {
  textures: BaseTexture[];
  materials?: readonly object[];
}): void {
  const modelTextures = modelAlbedoTextures(scene.materials);
  for (const texture of scene.textures) {
    if (isEngineOwnedGpuTexture(texture)) continue;
    if (modelTextures.has(texture)) continue;
    applyPixelArtSampling(texture);
  }
}

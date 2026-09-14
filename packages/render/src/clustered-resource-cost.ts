import { Constants, type BaseTexture } from "@babylonjs/core";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import type { ManagedLightingResource } from "./managed-lighting-resources";

/** Pinned 9.20 WebGL2: one R32F tile mask and one RGBA32F five-texel light row. */
export function clusteredTextureAllocationBytes(
  batchSize: number,
  batches: number,
): number {
  return batches * (64 * 64 * 4 + 5 * batchSize * 16);
}

/** Actual uncompressed storage, including complete mip chains and MSAA resolve storage. */
export function managedTextureResource(
  texture: BaseTexture,
): ManagedLightingResource {
  const internal = texture.getInternalTexture();
  if (!internal) throw new Error("Managed lighting texture has no allocation.");
  const channels =
    internal.format === Constants.TEXTUREFORMAT_R
      ? 1
      : internal.format === Constants.TEXTUREFORMAT_RG
        ? 2
        : internal.format === Constants.TEXTUREFORMAT_RGB
          ? 3
          : internal.format === Constants.TEXTUREFORMAT_RGBA
            ? 4
            : undefined;
  const componentBytes =
    internal.type === Constants.TEXTURETYPE_FLOAT
      ? 4
      : internal.type === Constants.TEXTURETYPE_HALF_FLOAT
        ? 2
        : internal.type === Constants.TEXTURETYPE_UNSIGNED_BYTE
          ? 1
          : undefined;
  if (
    !channels ||
    !componentBytes ||
    internal.isCube ||
    internal.is3D ||
    internal.is2DArray
  )
    throw new Error("Unqualified managed lighting texture layout.");
  let width = internal.width;
  let height = internal.height;
  const samples = Math.max(1, internal.samples);
  if (
    ![width, height, samples].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("Invalid managed lighting texture dimensions or samples.");
  const base = width * height;
  let texels = base;
  if (internal.generateMipMaps)
    while (width > 1 || height > 1) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
      texels += width * height;
    }
  // The multisample color attachment is additional to its resolved texture.
  if (samples > 1) texels += base * samples;
  return { handle: internal, bytes: texels * channels * componentBytes };
}

/** Guard the pinned native owner; borrowed graph imports never create new leases. */
export function clusteredTextureResources(
  container: ClusteredLightContainer,
): ManagedLightingResource[] {
  const fields = container as unknown as {
    _lightDataTexture?: BaseTexture;
    _tileMaskTexture?: BaseTexture;
  };
  if (
    !fields._lightDataTexture ||
    !fields._tileMaskTexture ||
    container.horizontalTiles !== 64 ||
    container.verticalTiles !== 64
  )
    throw new Error("Unqualified clustered texture allocation layout.");
  const data = managedTextureResource(fields._lightDataTexture);
  const mask = managedTextureResource(fields._tileMaskTexture);
  return [data, mask];
}

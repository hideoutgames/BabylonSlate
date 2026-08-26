import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { sniffImageSize, sniffKtx2Size } from "@babylonslate/assets";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";

export const OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE = { width: 1, height: 1 };

/**
 * Overlay 2DTexture world size from sniffed GPU bytes (KTX2, then PNG/JPEG).
 * Missing guid/bytes stay 1×1. Does not read Babylon Texture.getSize().
 */
export function overlayTextureWorldSize(
  guid: string | null | undefined,
  textureBytes: ReadonlyMap<string, Uint8Array | Blob> | undefined,
  pixelsPerUnit = 100,
): { width: number; height: number } {
  if (!guid || !textureBytes) {
    return { ...OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE };
  }
  const bytes = textureBytes.get(guid);
  if (!(bytes instanceof Uint8Array)) {
    return { ...OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE };
  }
  const px = sniffKtx2Size(bytes) ?? sniffImageSize(bytes);
  if (!px) {
    return { ...OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE };
  }
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  return {
    width: px.width / ppu,
    height: px.height / ppu,
  };
}

export function overlayTextureVisualKind(
  guid: string | null | undefined,
  hitTest: unknown,
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>,
  pixelsPerUnit?: number,
): string {
  const size = overlayTextureWorldSize(guid, textureBytes, pixelsPerUnit);
  return `2dtexture:${guid ?? ""}:${size.width}x${size.height}:${String(hitTest ?? "ignore")}`;
}

/** Unlit overlay plane sized to the texture, then albedo if bytes are cached. */
export function createOverlayTextureQuad(
  scene: Scene,
  name: string,
  textureGuid: string | null | undefined,
  assets?: MeshAssetContext,
): Mesh {
  const size = overlayTextureWorldSize(
    textureGuid,
    assets?.textureBytes,
    assets?.pixelsPerUnit,
  );
  const mesh = MeshBuilder.CreatePlane(
    name,
    { width: size.width, height: size.height },
    scene,
  );
  const material = new StandardMaterial(`${name}-unlit`, scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.White();
  material.backFaceCulling = false;
  mesh.material = material;
  applyAlbedoTexture(mesh, scene, textureGuid, assets);
  return mesh;
}

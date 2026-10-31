import {
  MeshBuilder,
  type AbstractMesh,
  type Mesh,
  type NodeMaterial,
  type Scene,
} from "@babylonjs/core";
import { sniffImageSize, sniffKtx2Size } from "@haptic/assets";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";

export const OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE = { width: 1, height: 1 };

/**
 * Overlay 2DTexture world size from authored Texture pixels / pixelsPerUnit.
 * GPU bytes (LOD/KTX2) are a fallback sniff only. Missing guid/size stays 1×1.
 */
export function overlayTextureWorldSize(
  guid: string | null | undefined,
  textureBytes: ReadonlyMap<string, Uint8Array | Blob> | undefined,
  pixelsPerUnit = 100,
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>,
): { width: number; height: number } {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  if (!guid) {
    return { ...OVERLAY_TEXTURE_DEFAULT_WORLD_SIZE };
  }
  const authored = texturePixelSizes?.get(guid);
  if (
    authored &&
    authored.width > 0 &&
    authored.height > 0
  ) {
    return {
      width: authored.width / ppu,
      height: authored.height / ppu,
    };
  }
  if (!textureBytes) {
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
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>,
): string {
  const size = overlayTextureWorldSize(
    guid,
    textureBytes,
    pixelsPerUnit,
    texturePixelSizes,
  );
  return `2dtexture:${guid ?? ""}:${size.width}x${size.height}:${String(hitTest ?? "ignore")}`;
}

/** An overlay surface's construction look: a flat unlit colour from both sides (white by default). */
const OVERLAY_UNLIT: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: true, role: "world" };

/** An overlay surface's construction look, reapplied after an authored material or texture stops drawing in its place. */
export interface OverlayUnlitFallback {
  readonly binding: UnlitBinding;
  /** Draws `mesh` (the surface by default) with the construction look; returns the unlit Material it draws. */
  apply(mesh?: AbstractMesh): NodeMaterial;
}

/** Draws `mesh` with its construction look now, and returns it for later restores. */
export function applyOverlayUnlitMaterial(
  mesh: AbstractMesh,
  color: readonly [number, number, number] = [1, 1, 1],
  alpha = 1,
): OverlayUnlitFallback {
  const binding: UnlitBinding = { texture: null, color, alpha, cutoff: 0, blend: false, textureAlpha: false, twoSided: false };
  const fallback: OverlayUnlitFallback = { binding, apply: (target = mesh) => setUnlitMaterial(target, OVERLAY_UNLIT, binding) };
  fallback.apply();
  return fallback;
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
    assets?.texturePixelSizes,
  );
  const mesh = MeshBuilder.CreatePlane(
    name,
    { width: size.width, height: size.height },
    scene,
  );
  try {
    applyOverlayUnlitMaterial(mesh);
    applyAlbedoTexture(mesh, scene, textureGuid, assets);
    return mesh;
  } catch (error) {
    mesh.dispose();
    throw error;
  }
}

import {
  Color3,
  Material,
  StandardMaterial,
  Texture,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import type { SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import type { ResourceCache } from "./resource-cache";

/** Bytes and payloads the editor / Play mesh builders use for authored content. */
export interface MeshAssetContext {
  resourceCache?: ResourceCache;
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  tilemaps?: ReadonlyMap<string, TilemapPayload>;
  tilesets?: ReadonlyMap<string, TilesetPayload>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  pixelsPerUnit?: number;
}

export function applyAlbedoTexture(
  mesh: Mesh,
  scene: Scene,
  textureGuid: string | null | undefined,
  assets?: MeshAssetContext,
): void {
  if (!textureGuid || !assets?.resourceCache || !assets.textureBytes) return;
  const bytes = assets.textureBytes.get(textureGuid);
  if (!bytes) return;
  const texture = assets.resourceCache.getTexture(
    textureGuid,
    scene.getEngine(),
    bytes,
    {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    },
  );
  const material = new StandardMaterial(`albedo:${textureGuid}`, scene);
  material.disableLighting = true;
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = Color3.White();
  texture.hasAlpha = true;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  material.alphaCutOff = 0.4;
  mesh.material = material;
  for (const child of mesh.getChildMeshes()) {
    child.material = material;
  }
}

import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
  type FloatArray,
} from "@babylonjs/core";
import type { SpriteFrame } from "@babylonslate/assets";
import { spriteFrameUvs } from "@babylonslate/assets";

export const SPRITE_QUAD_NAME_PREFIX = "spriteQuad:";

/**
 * XY-plane quad with the atlas frame baked into UVs (not BABYLON.Sprite).
 * Default size is 1 world unit; callers scale by frame pixels / pixelsPerUnit.
 */
export function createSpriteQuad(
  scene: Scene,
  name: string,
  frame: SpriteFrame,
  pixelsPerUnit = 100,
): Mesh {
  const width = (frame.width ?? 100) / pixelsPerUnit;
  const height = (frame.height ?? 100) / pixelsPerUnit;
  const mesh = MeshBuilder.CreatePlane(
    name,
    { width: width || 1, height: height || 1 },
    scene,
  );
  applySpriteFrameUvs(mesh, frame);
  return mesh;
}

export function applySpriteFrameUvs(mesh: Mesh, frame: SpriteFrame): void {
  const { u0, v0, u1, v1 } = spriteFrameUvs(frame);
  // CreatePlane UV order: bottom-left, bottom-right, top-right, top-left
  // in Babylon's left-handed XY plane (engineplan §13).
  const uvs: FloatArray = [u0, v0, u1, v0, u1, v1, u0, v1];
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

export function spriteWorldX(mesh: Mesh): number {
  return mesh.getAbsolutePosition().x;
}

import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
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
    { width: width || 1, height: height || 1, updatable: true },
    scene,
  );
  applySpriteFrameUvs(mesh, frame);
  return mesh;
}

const appliedQuads = new WeakMap<Mesh, { positions: Float32Array; uvs: Float32Array; width?: number; height?: number; u0?: number; v0?: number; u1?: number; v1?: number }>();
function quadState(mesh: Mesh) {
  let state = appliedQuads.get(mesh);
  if (!state) {
    state = { positions: new Float32Array(12), uvs: new Float32Array(8) };
    appliedQuads.set(mesh, state);
  }
  return state;
}

export function setSpriteQuadSize(mesh: Mesh, width: number, height: number): void {
  const state = quadState(mesh);
  width = Math.max(0, width); height = Math.max(0, height);
  if (state.width === width && state.height === height) return;
  const hw = width / 2; const hh = height / 2;
  state.positions.set([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0]);
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  if (!mesh.getVertexBuffer(VertexBuffer.PositionKind)?.isUpdatable()) mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
  mesh.updateVerticesData(VertexBuffer.PositionKind, state.positions, true, false);
  state.width = width; state.height = height;
}

export function applySpriteFrameUvs(mesh: Mesh, frame: SpriteFrame): void {
  const state = quadState(mesh);
  const { u0, v0, u1, v1 } = spriteFrameUvs(frame);
  if (state.u0 === u0 && state.v0 === v0 && state.u1 === u1 && state.v1 === v1) return;
  state.uvs.set([u0, v0, u1, v0, u1, v1, u0, v1]);
  if (!mesh.getVertexBuffer(VertexBuffer.UVKind)?.isUpdatable()) mesh.markVerticesDataAsUpdatable(VertexBuffer.UVKind, true);
  mesh.updateVerticesData(VertexBuffer.UVKind, state.uvs, false, false);
  state.u0 = u0; state.v0 = v0; state.u1 = u1; state.v1 = v1;
}

export function spriteWorldX(mesh: Mesh): number {
  return mesh.getAbsolutePosition().x;
}

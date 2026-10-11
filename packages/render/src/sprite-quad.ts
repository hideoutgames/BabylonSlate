import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
} from "@babylonjs/core";
import type { SpriteFrame } from "@babylonslate/assets";
import { spriteFrameUvs } from "@babylonslate/assets";

const spriteQuads = new WeakSet<Mesh>();
export function isSpriteQuad(mesh: unknown): boolean { return mesh instanceof Mesh && spriteQuads.has(mesh); }

/**
 * XY-plane quad with the atlas frame baked into UVs (not BABYLON.Sprite).
 * Sized from frame pixels / pixelsPerUnit and offset so the frame pivot sits
 * at the mesh origin, the same origin `spriteCollisionToBox2d` uses.
 */
export function createSpriteQuad(
  scene: Scene,
  name: string,
  frame: SpriteFrame,
  pixelsPerUnit = 100,
): Mesh {
  const width = (frame.width ?? 100) / pixelsPerUnit || 1;
  const height = (frame.height ?? 100) / pixelsPerUnit || 1;
  const mesh = MeshBuilder.CreatePlane(name, { width, height, updatable: true }, scene);
  spriteQuads.add(mesh);
  setSpriteQuadSize(mesh, width, height, frame.pivot);
  applySpriteFrameUvs(mesh, frame);
  return mesh;
}

const appliedQuads = new WeakMap<Mesh, { positions: Float32Array; uvs: Float32Array; width?: number; height?: number; pivotX?: number; pivotY?: number; u0?: number; v0?: number; u1?: number; v1?: number }>();
function quadState(mesh: Mesh) {
  let state = appliedQuads.get(mesh);
  if (!state) {
    state = { positions: new Float32Array(12), uvs: new Float32Array(8) };
    appliedQuads.set(mesh, state);
  }
  return state;
}

/** Resize the quad; the normalized `pivot` (v grows downward) lands on the mesh origin. */
export function setSpriteQuadSize(mesh: Mesh, width: number, height: number, pivot: { x: number; y: number }): void {
  const state = quadState(mesh);
  width = Math.max(0, width); height = Math.max(0, height);
  if (state.width === width && state.height === height && state.pivotX === pivot.x && state.pivotY === pivot.y) return;
  const left = -pivot.x * width; const right = left + width;
  const top = pivot.y * height; const bottom = top - height;
  state.positions.set([left, bottom, 0, right, bottom, 0, right, top, 0, left, top, 0]);
  if (!mesh.getVertexBuffer(VertexBuffer.PositionKind)?.isUpdatable()) mesh.markVerticesDataAsUpdatable(VertexBuffer.PositionKind, true);
  mesh.updateVerticesData(VertexBuffer.PositionKind, state.positions, true, false);
  // updateVerticesData rebuilds the bounds without the world matrix, which an
  // unchanged (or frozen) transform never recomputes: refresh them against it.
  mesh.refreshBoundingInfo();
  state.width = width; state.height = height; state.pivotX = pivot.x; state.pivotY = pivot.y;
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

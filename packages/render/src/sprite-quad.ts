import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
} from "@babylonjs/core";
import { spriteWorldSize, type SpritePayload } from "@haptic/assets";
import { markOwnerNotifiedGeometry } from "./geometry-revision";

const spriteQuads = new WeakSet<Mesh>();
export function isSpriteQuad(mesh: unknown): boolean { return mesh instanceof Mesh && spriteQuads.has(mesh); }

/** The whole texture, corner by corner in the quad's vertex order (bottom-left first). */
const FULL_TEXTURE_UVS = [0, 0, 1, 0, 1, 1, 0, 1];

/**
 * XY-plane quad showing a whole texture (not BABYLON.Sprite). Sized from the
 * image's pixels / pixelsPerUnit and offset so the pivot sits at the mesh
 * origin, the same origin `spriteCollisionToBox2d` uses.
 */
export function createSpriteQuad(
  scene: Scene,
  name: string,
  sprite: Pick<SpritePayload, "pivot" | "width" | "height">,
  pixelsPerUnit = 100,
): Mesh {
  const { width, height } = spriteWorldSize({ pixelsPerUnit, width: sprite.width, height: sprite.height });
  const mesh = MeshBuilder.CreatePlane(name, { width, height, updatable: true }, scene);
  spriteQuads.add(mesh);
  // Resizes rewrite positions through notified updates only.
  markOwnerNotifiedGeometry(mesh);
  setSpriteQuadSize(mesh, width, height, sprite.pivot);
  mesh.setVerticesData(VertexBuffer.UVKind, FULL_TEXTURE_UVS, false);
  return mesh;
}

const appliedQuads = new WeakMap<Mesh, { positions: Float32Array; width?: number; height?: number; pivotX?: number; pivotY?: number }>();
function quadState(mesh: Mesh) {
  let state = appliedQuads.get(mesh);
  if (!state) {
    state = { positions: new Float32Array(12) };
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


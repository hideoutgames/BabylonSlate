import { Mesh, Scene, VertexData } from "@babylonjs/core";
import {
  tilemapChunkVertexData,
  tilemapParallaxOffset,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { applySortingToMesh, resolveSortingLayer } from "./sorting";

const DEFAULT_SORTING_LAYERS = ["Background", "Default", "Foreground", "UI"];

/** Build a parent mesh plus one child draw per non-empty chunk (and an `:anim` sibling). */
export function createTilemapMeshes(
  scene: Scene,
  name: string,
  tilemap: TilemapPayload,
  tileset: TilesetPayload,
  worldTileWidth: number,
  worldTileHeight: number,
): Mesh {
  const root = new Mesh(name, scene);
  for (const layer of tilemap.layers) {
    if (!layer.visible) continue;
    const sorting = resolveSortingLayer(
      DEFAULT_SORTING_LAYERS,
      layer.sortingLayer,
      layer.orderInLayer,
    );
    for (const chunk of layer.chunks) {
      appendChunkMesh(
        scene,
        root,
        `${name}:${layer.id}:${chunk.cx}:${chunk.cy}`,
        tilemapChunkVertexData({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset,
          worldTileWidth,
          worldTileHeight,
          kind: "static",
        }),
        layer.parallax,
        sorting,
      );
      appendChunkMesh(
        scene,
        root,
        `${name}:${layer.id}:${chunk.cx}:${chunk.cy}:anim`,
        tilemapChunkVertexData({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset,
          worldTileWidth,
          worldTileHeight,
          kind: "animated",
        }),
        layer.parallax,
        sorting,
      );
    }
  }
  return root;
}

export function worldTileSize(
  tilemap: TilemapPayload,
  pixelsPerUnit: number,
): { width: number; height: number } {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  return {
    width: tilemap.tileWidth / ppu,
    height: tilemap.tileHeight / ppu,
  };
}

/** Offset chunk children so per-layer parallax tracks the Play camera. */
export function applyTilemapParallaxToMesh(
  mesh: Mesh,
  camera: { position: { x: number; y: number } },
): void {
  for (const child of mesh.getChildMeshes()) {
    const parallax = child.metadata?.tilemapParallax as
      | { x: number; y: number }
      | undefined;
    if (!parallax) continue;
    const offset = tilemapParallaxOffset(parallax, camera.position);
    child.position.x = offset.x;
    child.position.y = offset.y;
  }
}

function appendChunkMesh(
  scene: Scene,
  root: Mesh,
  name: string,
  data: ReturnType<typeof tilemapChunkVertexData>,
  parallax: { x: number; y: number },
  sorting: ReturnType<typeof resolveSortingLayer>,
): Mesh | null {
  if (data.positions.length === 0) return null;
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
  vertexData.uvs = data.uvs;
  vertexData.indices = data.indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(data.positions, data.indices, normals);
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh, true);
  mesh.parent = root;
  mesh.metadata = { ...(mesh.metadata ?? {}), tilemapParallax: parallax };
  applySortingToMesh(mesh, sorting);
  return mesh;
}

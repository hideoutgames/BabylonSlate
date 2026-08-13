import { Mesh, Scene, VertexData } from "@babylonjs/core";
import {
  tilemapChunkVertexData,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";

/** Build a parent mesh plus one child draw per non-empty chunk. */
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
    for (const chunk of layer.chunks) {
      const data = tilemapChunkVertexData({
        tiles: chunk.tiles,
        chunkSize: tilemap.chunkSize,
        chunkX: chunk.cx,
        chunkY: chunk.cy,
        tileset,
        worldTileWidth,
        worldTileHeight,
      });
      if (data.positions.length === 0) continue;
      const mesh = new Mesh(`${name}:${layer.id}:${chunk.cx}:${chunk.cy}`, scene);
      const vertexData = new VertexData();
      vertexData.positions = data.positions;
      vertexData.uvs = data.uvs;
      vertexData.indices = data.indices;
      const normals: number[] = [];
      VertexData.ComputeNormals(data.positions, data.indices, normals);
      vertexData.normals = normals;
      vertexData.applyToMesh(mesh, true);
      mesh.parent = root;
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

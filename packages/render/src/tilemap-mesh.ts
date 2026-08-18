import { Mesh, Scene, VertexData } from "@babylonjs/core";
import {
  tilemapChunkVertexData,
  tilemapParallaxOffset,
  decodeTileGid,
  tilemapTilesetGuids,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { applySortingToMesh, resolveSortingLayer } from "./sorting";

const DEFAULT_SORTING_LAYERS = ["Background", "Default", "Foreground", "UI"];

/** Build a parent mesh plus one child draw per non-empty chunk atlas (and an `:anim` sibling). */
export function createTilemapMeshes(
  scene: Scene,
  name: string,
  tilemap: TilemapPayload,
  tilesets: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): Mesh {
  const atlasMap = asTilesetMap(tilemap, tilesets);
  const resolveGid = (gid: number) => {
    const hit = decodeTileGid(tilemap, gid, atlasMap);
    if (hit) return hit;
    if (atlasMap.size === 1) {
      const [guid, tileset] = [...atlasMap.entries()][0]!;
      return { guid, localId: gid, tileset };
    }
    return null;
  };
  const root = new Mesh(name, scene);
  for (const layer of tilemap.layers) {
    if (!layer.visible) continue;
    const sorting = resolveSortingLayer(
      DEFAULT_SORTING_LAYERS,
      layer.sortingLayer,
      layer.orderInLayer,
    );
    for (const chunk of layer.chunks) {
      const atlasGuids = chunkAtlasGuids(chunk.tiles, resolveGid, atlasMap);
      atlasGuids.forEach((guid, atlasIndex) => {
        const tileset = atlasMap.get(guid);
        if (!tileset) return;
        const suffix = atlasIndex === 0 ? "" : `:a${atlasIndex}`;
        const staticMesh = appendChunkMesh(
          scene,
          root,
          `${name}:${layer.id}:${chunk.cx}:${chunk.cy}${suffix}`,
          tilemapChunkVertexData({
            tiles: chunk.tiles,
            chunkSize: tilemap.chunkSize,
            chunkX: chunk.cx,
            chunkY: chunk.cy,
            tileset,
            worldTileWidth,
            worldTileHeight,
            kind: "static",
            resolveGid,
            atlasGuid: guid,
          }),
          layer.parallax,
          sorting,
        );
        const animMesh = appendChunkMesh(
          scene,
          root,
          `${name}:${layer.id}:${chunk.cx}:${chunk.cy}${suffix}:anim`,
          tilemapChunkVertexData({
            tiles: chunk.tiles,
            chunkSize: tilemap.chunkSize,
            chunkX: chunk.cx,
            chunkY: chunk.cy,
            tileset,
            worldTileWidth,
            worldTileHeight,
            kind: "animated",
            resolveGid,
            atlasGuid: guid,
          }),
          layer.parallax,
          sorting,
        );
        if (staticMesh) {
          staticMesh.metadata = {
            ...(staticMesh.metadata ?? {}),
            tilemapTextureGuid: tileset.textureGuid,
          };
        }
        if (animMesh) {
          animMesh.metadata = {
            ...(animMesh.metadata ?? {}),
            tilemapTextureGuid: tileset.textureGuid,
          };
        }
      });
    }
  }
  return root;
}

function asTilesetMap(
  tilemap: TilemapPayload,
  tilesets: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
): ReadonlyMap<string, TilesetPayload> {
  if (isTilesetMap(tilesets)) return tilesets;
  const guid =
    tilemap.tilesetGuid ?? tilemap.tilesets[0]?.guid ?? tilemapTilesetGuids(tilemap)[0] ?? "_";
  return new Map([[guid, tilesets]]);
}

function isTilesetMap(
  value: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
): value is ReadonlyMap<string, TilesetPayload> {
  return (
    typeof (value as ReadonlyMap<string, TilesetPayload>).get === "function" &&
    !Array.isArray((value as TilesetPayload).tiles)
  );
}

function chunkAtlasGuids(
  tiles: readonly number[],
  resolveGid: (gid: number) => { guid: string } | null,
  atlasMap: ReadonlyMap<string, TilesetPayload>,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  const add = (guid: string) => {
    if (!guid || seen.has(guid) || !atlasMap.has(guid)) return;
    seen.add(guid);
    guids.push(guid);
  };
  for (const gid of tiles) {
    if (gid <= 0) continue;
    const hit = resolveGid(gid);
    if (hit) add(hit.guid);
  }
  return guids;
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

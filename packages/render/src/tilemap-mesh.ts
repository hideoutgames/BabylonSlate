import { Mesh, Scene, VertexBuffer, VertexData, type AbstractMesh } from "@babylonjs/core";
import {
  tilemapChunkVertexData,
  decodeTileGid,
  tilemapTilesetGuids,
  tilesetAnimationFrame,
  tilesetTileUv,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { DEFAULT_SORTING_LAYERS } from "@babylonslate/core";
import { applyComponentSorting } from "./sorting";

type AnimatedChunk = {
  mesh: Mesh;
  /** Typed so an upload does not convert the whole array each frame change. */
  uvs: Float32Array;
  tiles: ReturnType<typeof tilemapChunkVertexData>["animatedTiles"];
  frames: number[];
};
const animatedChunks = new WeakMap<Scene, Set<AnimatedChunk>>();
/** Chunks whose layer parallax moves them; a parallax of 1 always stays at 0. */
const parallaxChunks = new WeakMap<Scene, Set<Mesh>>();

/** Seek only animated UVs. Static geometry, collision and atlas materials stay intact. */
export function updateSceneTilemapAnimations(scene: Scene, elapsedMs: number): void {
  const chunks = animatedChunks.get(scene);
  if (!chunks) return;
  for (const chunk of chunks) {
    let changed = false;
    for (let index = 0; index < chunk.tiles.length; index++) {
      const tile = chunk.tiles[index]!;
      const frame = tilesetAnimationFrame(tile.tileset, tile.tile, elapsedMs);
      if (frame === chunk.frames[index]) continue;
      const uv = tilesetTileUv(tile.tileset, frame);
      if (!uv) continue;
      chunk.frames[index] = frame;
      const uvs = chunk.uvs;
      const at = tile.uvOffset;
      uvs[at] = uv.u0; uvs[at + 1] = uv.v0; uvs[at + 2] = uv.u1; uvs[at + 3] = uv.v0;
      uvs[at + 4] = uv.u1; uvs[at + 5] = uv.v1; uvs[at + 6] = uv.u0; uvs[at + 7] = uv.v1;
      changed = true;
    }
    if (changed) chunk.mesh.updateVerticesData(VertexBuffer.UVKind, chunk.uvs);
  }
}

/** Atlas materials belong to tilemap draws, not their actor's mesh material slots. */
export function isTilemapChunkMesh(mesh: AbstractMesh): boolean {
  return Object.prototype.hasOwnProperty.call(mesh.metadata ?? {}, "tilemapTextureGuid");
}

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
    if (!isTilesetMap(tilesets) && tilemapTilesetGuids(tilemap).length === 0) {
      const [guid, tileset] = [...atlasMap.entries()][0]!;
      return { guid, localId: gid, tileset };
    }
    return null;
  };
  const root = new Mesh(name, scene);
  for (const [ordinal, layer] of tilemap.layers.entries()) {
    if (!layer.visible) continue;
    const sorting = { name: layer.sortingLayer, order: layer.orderInLayer, ordinal };
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
  applyComponentSorting(root, DEFAULT_SORTING_LAYERS);
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

/** Offset this Scene's parallax chunks so each layer tracks the Play camera. */
export function updateSceneTilemapParallax(
  scene: Scene,
  camera: { x: number; y: number },
): void {
  const chunks = parallaxChunks.get(scene);
  if (!chunks) return;
  for (const chunk of chunks) {
    const parallax = chunk.metadata?.tilemapParallax as
      | { x: number; y: number }
      | undefined;
    if (!parallax) continue;
    // Same offset as tilemapParallaxOffset, without a result object per chunk.
    chunk.position.x = camera.x * (1 - parallax.x);
    chunk.position.y = camera.y * (1 - parallax.y);
  }
}

function appendChunkMesh(
  scene: Scene,
  root: Mesh,
  name: string,
  data: ReturnType<typeof tilemapChunkVertexData>,
  parallax: { x: number; y: number },
  sorting: { name: string; order: number; ordinal: number },
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
  if (data.animatedTiles.length > 0) {
    let chunks = animatedChunks.get(scene);
    if (!chunks) {
      chunks = new Set();
      animatedChunks.set(scene, chunks);
    }
    const chunk: AnimatedChunk = {
      mesh, uvs: new Float32Array(data.uvs), tiles: data.animatedTiles,
      frames: data.animatedTiles.map((tile) => tilesetAnimationFrame(tile.tileset, tile.tile, 0)),
    };
    chunks.add(chunk);
    mesh.onDisposeObservable.addOnce(() => chunks.delete(chunk));
  }
  if (parallax.x !== 1 || parallax.y !== 1) {
    let chunks = parallaxChunks.get(scene);
    if (!chunks) {
      chunks = new Set();
      parallaxChunks.set(scene, chunks);
    }
    chunks.add(mesh);
    mesh.onDisposeObservable.addOnce(() => chunks.delete(mesh));
  }
  mesh.parent = root;
  mesh.metadata = { ...(mesh.metadata ?? {}), tilemapParallax: parallax, tilemapLayer: sorting };
  return mesh;
}

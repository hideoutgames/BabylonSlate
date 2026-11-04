import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import {
  tilemapChunkDraws,
  decodeTileGid,
  tilemapCellKey,
  tilemapTilesetGuids,
  tilesetAnimationFrame,
  tilesetTileUv,
  type TilemapChunk,
  type TilemapChunkVertexData,
  type TilemapLayer,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import { DEFAULT_SORTING_LAYERS } from "@haptic/core";
import { markOwnerNotifiedGeometry } from "./geometry-revision";
import { applyComponentSorting } from "./sorting";
import { setTilemapPivotNode, tilemapChunkParent } from "./tilemap-chunk-parent";

type AnimatedChunk = {
  mesh: Mesh;
  /** Typed so an upload does not convert the whole array each frame change. */
  uvs: Float32Array;
  tiles: TilemapChunkVertexData["animatedTiles"];
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

/**
 * Build a parent mesh plus one child draw per non-empty chunk atlas (and an
 * `:anim` sibling). Chunk geometry stays in map space (cell (0, 0) at the
 * origin); an unbounded map hangs its chunks under a `<name>:pivot` node moved
 * by −pivot × tile size, so its pivot sits on the root. Layer parallax writes
 * each chunk's own position, so it never undoes the pivot.
 */
export function createTilemapMeshes(
  scene: Scene,
  name: string,
  tilemap: TilemapPayload,
  tilesets: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): Mesh {
  const root = new Mesh(name, scene);
  if (tilemap.unbounded) {
    const pivot = new TransformNode(`${name}:pivot`, scene);
    pivot.parent = root;
    pivot.position.set(-tilemap.pivot.x * worldTileWidth, -tilemap.pivot.y * worldTileHeight, 0);
    setTilemapPivotNode(root, pivot);
  }
  const build = chunkBuilder(scene, root, tilemap, tilesets, worldTileWidth, worldTileHeight);
  for (const [ordinal, layer] of tilemap.layers.entries()) {
    if (!layer.visible) continue;
    for (const chunk of layer.chunks) build(layer, ordinal, chunk);
  }
  applyComponentSorting(root, DEFAULT_SORTING_LAYERS);
  return root;
}

/**
 * Builds one chunk's draws under `root` (its pivot node, for an unbounded
 * map), in one pass over its tiles (`tilemapChunkDraws`): a static draw per
 * atlas named `<root>:<layer>:<cx>:<cy>` (`:a1`, `:a2` … for later atlases)
 * and an `:anim` sibling for its animated tiles. Returns the meshes made.
 */
function chunkBuilder(
  scene: Scene,
  root: Mesh,
  tilemap: TilemapPayload,
  tilesets: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): (layer: TilemapLayer, ordinal: number, chunk: TilemapChunk) => Mesh[] {
  const parent = tilemapChunkParent(root);
  const atlasMap = asTilesetMap(tilemap, tilesets);
  const legacyTileset = !isTilesetMap(tilesets) && tilemapTilesetGuids(tilemap).length === 0
    ? [...atlasMap.entries()][0]!
    : null;
  const resolveGid = (gid: number) => {
    const hit = decodeTileGid(tilemap, gid, atlasMap);
    if (hit) return hit;
    return legacyTileset ? { guid: legacyTileset[0], localId: gid, tileset: legacyTileset[1] } : null;
  };
  return (layer, ordinal, chunk) => {
    const sorting = { name: layer.sortingLayer, order: layer.orderInLayer, ordinal };
    const meshes: Mesh[] = [];
    for (const draw of tilemapChunkDraws({
      tiles: chunk.tiles,
      chunkSize: tilemap.chunkSize,
      chunkX: chunk.cx,
      chunkY: chunk.cy,
      worldTileWidth,
      worldTileHeight,
      resolveGid,
      placeholderColors: (tileset) => !tileset.textureGuid,
    })) {
      const suffix = (draw.atlasIndex === 0 ? "" : `:a${draw.atlasIndex}`) + (draw.kind === "animated" ? ":anim" : "");
      const mesh = appendChunkMesh(scene, parent, `${root.name}:${layer.id}:${chunk.cx}:${chunk.cy}${suffix}`, draw.data, layer.parallax, sorting);
      if (!mesh) continue;
      mesh.metadata = {
        ...(mesh.metadata ?? {}),
        tilemapTextureGuid: draw.tileset.textureGuid,
        tilemapChunk: chunkMeshKey(layer.id, chunk.cx, chunk.cy),
      };
      meshes.push(mesh);
    }
    return meshes;
  };
}

/** The chunk a chunk mesh draws, as `metadata.tilemapChunk` holds it. */
function chunkMeshKey(layerId: string, cx: number, cy: number): string {
  return `${layerId}\u0000${tilemapCellKey(cx, cy)}`;
}

/**
 * Whether two chunks hold the same cells: the same array, or (a map read
 * separately, such as a Tilemap tab opened after the Scene collected the
 * saved file) an equal one, so its meshes are kept.
 */
function sameTiles(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

/** The GID ranges a map's Tileset list decodes with (its terrain stamps do not change a cell's tile). */
function tilesetRangesKey(map: TilemapPayload): string {
  return JSON.stringify(map.tilesets.map((ref) => [ref.guid, ref.firstGid, ref.tileCount]));
}

/** Layer settings that place or show its chunk meshes, compared when an edit is patched in. */
function layerDrawKey(layer: TilemapLayer): string {
  return JSON.stringify([layer.id, layer.visible, layer.sortingLayer, layer.orderInLayer, layer.parallax.x, layer.parallax.y]);
}

/**
 * Bring a Tilemap's chunk meshes under `root` (built by `createTilemapMeshes`
 * from `previous`) up to `next`, rebuilding only the chunks whose `tiles`
 * changed: a chunk whose array is the same object, or holds the same cells,
 * keeps its meshes. Returns the meshes made (empty when no chunk changed), or
 * `null` when `next` changes what every chunk draws with (tile size, chunk
 * size, the Tileset list, the layer list or a layer's visibility, sorting or
 * parallax) or where they sit (`unbounded`, the pivot), which the caller
 * rebuilds whole.
 */
export function patchTilemapMeshes(
  scene: Scene,
  root: Mesh,
  previous: TilemapPayload,
  next: TilemapPayload,
  tilesets: ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): Mesh[] | null {
  if (
    previous.tileWidth !== next.tileWidth || previous.tileHeight !== next.tileHeight ||
    previous.chunkSize !== next.chunkSize || previous.layers.length !== next.layers.length ||
    Boolean(previous.unbounded) !== Boolean(next.unbounded) ||
    previous.pivot?.x !== next.pivot?.x || previous.pivot?.y !== next.pivot?.y ||
    (previous.tilesets !== next.tilesets && tilesetRangesKey(previous) !== tilesetRangesKey(next)) ||
    previous.layers.some((layer, at) => layer !== next.layers[at] && layerDrawKey(layer) !== layerDrawKey(next.layers[at]!))
  ) return null;
  const changed = new Set<string>();
  const rebuild: Array<{ layer: TilemapLayer; ordinal: number; chunk: TilemapChunk }> = [];
  next.layers.forEach((layer, ordinal) => {
    const before = previous.layers[ordinal]!;
    if (before === layer || before.chunks === layer.chunks) return;
    const old = new Map(before.chunks.map((chunk) => [tilemapCellKey(chunk.cx, chunk.cy), chunk]));
    for (const chunk of layer.chunks) {
      const key = tilemapCellKey(chunk.cx, chunk.cy);
      const was = old.get(key);
      old.delete(key);
      if (was && sameTiles(was.tiles, chunk.tiles)) continue;
      changed.add(chunkMeshKey(layer.id, chunk.cx, chunk.cy));
      if (layer.visible) rebuild.push({ layer, ordinal, chunk });
    }
    for (const chunk of old.values()) changed.add(chunkMeshKey(layer.id, chunk.cx, chunk.cy));
  });
  if (changed.size === 0) return [];
  for (const mesh of tilemapChunkParent(root).getChildMeshes(true)) {
    if (changed.has(mesh.metadata?.tilemapChunk as string)) mesh.dispose();
  }
  const build = chunkBuilder(scene, root, next, tilesets, worldTileWidth, worldTileHeight);
  return rebuild.flatMap(({ layer, ordinal, chunk }) => build(layer, ordinal, chunk));
}

function asTilesetMap(
  tilemap: TilemapPayload,
  tilesets: TilesetPayload | ReadonlyMap<string, TilesetPayload>,
): ReadonlyMap<string, TilesetPayload> {
  if (isTilesetMap(tilesets)) return tilesets;
  const guid = tilemapTilesetGuids(tilemap)[0] ?? "_";
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

const scratchParallaxOffset = new Vector3();
const scratchParallaxInverse = new Matrix();

/** Offset this Scene's parallax chunks so each layer tracks the Play camera. */
export function updateSceneTilemapParallax(
  scene: Scene,
  camera: { x: number; y: number },
): void {
  const chunks = parallaxChunks.get(scene);
  if (!chunks) return;
  let inverted: Node | null = null;
  for (const chunk of chunks) {
    const parallax = chunk.metadata?.tilemapParallax as
      | { x: number; y: number }
      | undefined;
    if (!parallax) continue;
    // Parallax 1 stays world-locked; 0 tracks the camera. The offset is a
    // world displacement, so undo the tilemap root's rotation and scale; its
    // translation stays the layer's authored placement.
    scratchParallaxOffset.set(camera.x * (1 - parallax.x), camera.y * (1 - parallax.y), 0);
    const parent = chunk.parent;
    if (parent) {
      if (parent !== inverted) {
        parent.computeWorldMatrix(true).invertToRef(scratchParallaxInverse);
        inverted = parent;
      }
      Vector3.TransformNormalToRef(scratchParallaxOffset, scratchParallaxInverse, scratchParallaxOffset);
    }
    chunk.position.copyFrom(scratchParallaxOffset);
  }
}

function appendChunkMesh(
  scene: Scene,
  parent: Mesh | TransformNode,
  name: string,
  data: TilemapChunkVertexData,
  parallax: { x: number; y: number },
  sorting: { name: string; order: number; ordinal: number },
): Mesh | null {
  if (data.positions.length === 0) return null;
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
  vertexData.uvs = data.uvs;
  vertexData.indices = data.indices;
  // Every quad lies in the XY plane facing -Z: the normal ComputeNormals gives it, without computing it.
  const normals = new Float32Array(data.positions.length);
  for (let at = 2; at < normals.length; at += 3) normals[at] = -1;
  vertexData.normals = normals;
  // Atlases without an image draw per-tile placeholder colours.
  if (data.colors) vertexData.colors = data.colors;
  // Only animated tiles rewrite a buffer (their UVs); static chunks upload once.
  vertexData.applyToMesh(mesh, data.animatedTiles.length > 0);
  // Animated tiles rewrite their UVs through notified updates only.
  markOwnerNotifiedGeometry(mesh);
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
  mesh.parent = parent;
  mesh.metadata = { ...(mesh.metadata ?? {}), tilemapParallax: parallax, tilemapLayer: sorting };
  return mesh;
}

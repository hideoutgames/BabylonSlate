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
  tilesetAnimationFrame,
  tilesetAnimationFrameDurationMs,
  tilesetTileUv,
  type TilemapChunk,
  type TilemapChunkVertexData,
  type TilemapLayer,
  type TilemapPayload,
  type TilesetPayload,
  type TilesetTile,
} from "@haptic/assets";
import { DEFAULT_SORTING_LAYERS } from "@haptic/core";
import { markOwnerNotifiedGeometry } from "./geometry-revision";
import { applyComponentSorting } from "./sorting";
import { setTilemapPivotNode, tilemapChunkParent } from "./tilemap-chunk-parent";

/** The animated tiles of a chunk that show the same Tileset tile: they always share one frame and one UV rectangle. */
type AnimatedTileGroup = {
  tileset: TilesetPayload;
  tile: TilesetTile;
  /** Where each of the group's quads starts in the chunk's UV buffer. */
  uvOffsets: number[];
  frame: number;
};
type AnimatedChunk = {
  mesh: Mesh;
  /** Typed so an upload does not convert the whole array each frame change. */
  uvs: Float32Array;
  groups: AnimatedTileGroup[];
  /** The animation time the groups' frames were last resolved at; `Infinity` until the first update. */
  resolvedAtMs: number;
  /** No group's frame changes while the time stays in [`resolvedAtMs`, `nextFrameMs`). */
  nextFrameMs: number;
};
const animatedChunks = new WeakMap<Scene, Set<AnimatedChunk>>();
type ParallaxState = {
  /** Chunks whose layer parallax moves them; a parallax of 1 always stays at 0. */
  chunks: Set<Mesh>;
  /** The camera position and each chunk parent's world matrix the chunks were last placed for. */
  cameraX: number;
  cameraY: number;
  parentWorlds: Map<Node, Matrix>;
  /** A chunk joined or left since the last placement. */
  stale: boolean;
};
const parallaxStates = new WeakMap<Scene, ParallaxState>();

/**
 * A frame boundary is `step × duration`, and both that product and the
 * `time / duration` the frame is read from round, so a time within one part in
 * 10¹² below a boundary may already read the next frame. Ending the skipped
 * span this far early keeps every skipped update one that would change nothing.
 */
const FRAME_BOUNDARY_MARGIN = 1 - 1e-12;

/**
 * Seek only animated UVs. Static geometry, collision and atlas materials stay intact.
 *
 * A tile's frame is a function of `floor(time / frameDuration)` alone, so a
 * chunk is skipped while the time stays at or after the time it was last
 * resolved at and before its earliest next frame boundary (a paused game
 * repeats the same time). Time going backwards, and a new chunk, resolve again.
 * Tileset payloads are immutable: a changed Tileset rebuilds the chunk.
 */
export function updateSceneTilemapAnimations(scene: Scene, elapsedMs: number): void {
  const chunks = animatedChunks.get(scene);
  if (!chunks) return;
  // As `tilesetAnimationFrame` reads the time.
  const time = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  for (const chunk of chunks) {
    if (time >= chunk.resolvedAtMs && time < chunk.nextFrameMs) continue;
    let changed = false;
    let nextFrameMs = Infinity;
    for (const group of chunk.groups) {
      const duration = tilesetAnimationFrameDurationMs(group.tile);
      const boundary = (Math.floor(time / duration) + 1) * duration * FRAME_BOUNDARY_MARGIN;
      if (boundary < nextFrameMs) nextFrameMs = boundary;
      const frame = tilesetAnimationFrame(group.tileset, group.tile, time);
      if (frame === group.frame) continue;
      const uv = tilesetTileUv(group.tileset, frame);
      if (!uv) continue;
      group.frame = frame;
      const uvs = chunk.uvs;
      for (const at of group.uvOffsets) {
        uvs[at] = uv.u0; uvs[at + 1] = uv.v0; uvs[at + 2] = uv.u1; uvs[at + 3] = uv.v0;
        uvs[at + 4] = uv.u1; uvs[at + 5] = uv.v1; uvs[at + 6] = uv.u0; uvs[at + 7] = uv.v1;
      }
      changed = true;
    }
    chunk.resolvedAtMs = time;
    chunk.nextFrameMs = nextFrameMs;
    if (changed) chunk.mesh.updateVerticesData(VertexBuffer.UVKind, chunk.uvs);
  }
}

/** Groups a chunk's animated tiles by the Tileset tile they show, each at its frame for time 0 (as the chunk is built). */
function animatedTileGroups(tiles: TilemapChunkVertexData["animatedTiles"]): AnimatedTileGroup[] {
  const groups: AnimatedTileGroup[] = [];
  const byTile = new Map<TilesetTile, AnimatedTileGroup[]>();
  for (const { tileset, tile, uvOffset } of tiles) {
    let sameTile = byTile.get(tile);
    if (!sameTile) byTile.set(tile, sameTile = []);
    let group = sameTile.find((candidate) => candidate.tileset === tileset);
    if (!group) {
      group = { tileset, tile, uvOffsets: [], frame: tilesetAnimationFrame(tileset, tile, 0) };
      sameTile.push(group);
      groups.push(group);
    }
    group.uvOffsets.push(uvOffset);
  }
  return groups;
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
  tilesets: ReadonlyMap<string, TilesetPayload>,
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
  tilesets: ReadonlyMap<string, TilesetPayload>,
  worldTileWidth: number,
  worldTileHeight: number,
): (layer: TilemapLayer, ordinal: number, chunk: TilemapChunk) => Mesh[] {
  const parent = tilemapChunkParent(root);
  const resolveGid = (gid: number) => decodeTileGid(tilemap, gid, tilesets);
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

/**
 * Offset this Scene's parallax chunks so each layer tracks the Play camera.
 *
 * A chunk's offset depends only on the camera position, its layer's parallax
 * and its parent's world matrix, so nothing is written while the camera
 * position and every chunk parent's world matrix equal the ones last placed
 * for and no chunk joined or left; otherwise one offset is computed per run of
 * chunks sharing a parent and a layer.
 */
export function updateSceneTilemapParallax(
  scene: Scene,
  camera: { x: number; y: number },
): void {
  const state = parallaxStates.get(scene);
  if (!state || state.chunks.size === 0) return;
  if (!state.stale && camera.x === state.cameraX && camera.y === state.cameraY) {
    let moved = false;
    for (const [parent, world] of state.parentWorlds) {
      if (parent.computeWorldMatrix(true).equals(world)) continue;
      moved = true;
      break;
    }
    if (!moved) return;
  }
  if (state.stale) state.parentWorlds.clear();
  state.stale = false;
  state.cameraX = camera.x;
  state.cameraY = camera.y;
  let inverted: Node | null = null;
  let placedParent: Node | null | undefined;
  let placedParallax: { x: number; y: number } | undefined;
  for (const chunk of state.chunks) {
    const parallax = chunk.metadata?.tilemapParallax as
      | { x: number; y: number }
      | undefined;
    if (!parallax) continue;
    const parent = chunk.parent;
    // A layer hands every chunk the same parallax object, so its chunks under one parent share the offset.
    if (parent !== placedParent || parallax !== placedParallax) {
      // Parallax 1 stays world-locked; 0 tracks the camera. The offset is a
      // world displacement, so undo the tilemap root's rotation and scale; its
      // translation stays the layer's authored placement.
      scratchParallaxOffset.set(camera.x * (1 - parallax.x), camera.y * (1 - parallax.y), 0);
      if (parent) {
        if (parent !== inverted) {
          const world = parent.computeWorldMatrix(true);
          world.invertToRef(scratchParallaxInverse);
          inverted = parent;
          const placedFor = state.parentWorlds.get(parent);
          if (placedFor) placedFor.copyFrom(world);
          else state.parentWorlds.set(parent, world.clone());
        }
        Vector3.TransformNormalToRef(scratchParallaxOffset, scratchParallaxInverse, scratchParallaxOffset);
      }
      placedParent = parent;
      placedParallax = parallax;
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
      mesh, uvs: new Float32Array(data.uvs), groups: animatedTileGroups(data.animatedTiles),
      resolvedAtMs: Infinity, nextFrameMs: 0,
    };
    chunks.add(chunk);
    mesh.onDisposeObservable.addOnce(() => chunks.delete(chunk));
  }
  if (parallax.x !== 1 || parallax.y !== 1) {
    let state = parallaxStates.get(scene);
    if (!state) {
      state = { chunks: new Set(), cameraX: 0, cameraY: 0, parentWorlds: new Map(), stale: true };
      parallaxStates.set(scene, state);
    }
    const joined = state;
    joined.chunks.add(mesh);
    joined.stale = true;
    mesh.onDisposeObservable.addOnce(() => {
      joined.chunks.delete(mesh);
      joined.stale = true;
    });
  }
  mesh.parent = parent;
  mesh.metadata = { ...(mesh.metadata ?? {}), tilemapParallax: parallax, tilemapLayer: sorting };
  return mesh;
}

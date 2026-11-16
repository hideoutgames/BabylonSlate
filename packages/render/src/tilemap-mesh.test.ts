import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultTilemapPayload,
  normalizeTilesetPayload,
  setTile,
  tilesetAtlasColumns,
  tilesetAtlasRows,
  tilesetTileUv,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import { createTilemapMeshes, updateSceneTilemapAnimations, updateSceneTilemapParallax } from "./tilemap-mesh";

/** A map listing `tileset` from GID 1, so each GID is that tile's local id. */
function listing(tileset: TilesetPayload): TilemapPayload {
  const tileCount = tilesetAtlasColumns(tileset) * tilesetAtlasRows(tileset);
  return { ...createDefaultTilemapPayload(), tilesets: [{ guid: "atlas", firstGid: 1, tileCount }] };
}
const atlas = (tileset: TilesetPayload) => new Map([["atlas", tileset]]);

describe("createTilemapMeshes", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 64,
      renderHeight: 64,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("creates one child mesh per non-empty chunk", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = listing(tileset);
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    expect(root.name).toBe("actor-0");
    expect(root.getChildren()).toHaveLength(1);
    const child = root.getChildren()[0] as unknown as {
      getVerticesData: (kind: string) => number[] | null;
    };
    const positions = child.getVerticesData(VertexBuffer.PositionKind);
    expect(Array.from(positions ?? [])).toEqual([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]);
  });

  it("keeps asset Foreground layers inside the default component group", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = listing(tileset);
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({
        ...layer,
        sortingLayer: "Foreground",
        orderInLayer: 7,
      })),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    const child = root.getChildMeshes()[0]!;
    expect(child.renderingGroupId).toBe(1);
    expect(child.alphaIndex).toBeGreaterThan(0);
    expect(child.metadata.tilemapLayer).toEqual({ name: "Foreground", order: 7, ordinal: 0 });
  });

  it("draws animated tiles as a separate child mesh", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 32,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      tiles: [
        { id: 1, animation: [] },
        { id: 2, animation: [2, 1] },
      ],
    });
    let tilemap = listing(tileset);
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    tilemap = setTile(tilemap, "layer-1", 1, 0, 2);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    const names = root.getChildMeshes().map((mesh) => mesh.name);
    expect(names.some((name) => name.endsWith(":anim"))).toBe(true);
    expect(names.some((name) => !name.endsWith(":anim"))).toBe(true);
    const animated = root.getChildMeshes().find((mesh) => mesh.name.endsWith(":anim"))!;
    const fixed = root.getChildMeshes().find((mesh) => !mesh.name.endsWith(":anim"))!;
    const originalUvs = [...animated.getVerticesData(VertexBuffer.UVKind)!];
    const positions = [...animated.getVerticesData(VertexBuffer.PositionKind)!];
    const animatedUpdate = vi.spyOn(animated, "updateVerticesData");
    const staticUpdate = vi.spyOn(fixed, "updateVerticesData");
    updateSceneTilemapAnimations(scene, 99);
    expect(animatedUpdate).not.toHaveBeenCalled();
    updateSceneTilemapAnimations(scene, 100);
    expect([...animated.getVerticesData(VertexBuffer.UVKind)!]).toEqual([...fixed.getVerticesData(VertexBuffer.UVKind)!]);
    updateSceneTilemapAnimations(scene, 200);
    expect([...animated.getVerticesData(VertexBuffer.UVKind)!]).toEqual(originalUvs);
    expect([...animated.getVerticesData(VertexBuffer.PositionKind)!]).toEqual(positions);
    expect(staticUpdate).not.toHaveBeenCalled();
    root.dispose();
    animatedUpdate.mockClear();
    updateSceneTilemapAnimations(scene, 300);
    expect(animatedUpdate).not.toHaveBeenCalled();
  });

  /**
   * A 2 × 2 chunk map of `tiles` animated tiles per chunk over a four-cell atlas: tile 1 loops [1, 2, 3] every 100 ms
   * and tile 2 loops [2, 4] every 70 ms. `lookups` counts reads of a tile's frame duration: resolving a tile's frame takes
   * two (its frame, and its next boundary), where a per-quad lookup took one for every quad on every update.
   */
  function animatedMap(chunks: number, tilesPerChunk: number) {
    const lookups = { count: 0 };
    const tileset = normalizeTilesetPayload({
      atlasWidth: 64, atlasHeight: 16, tileWidth: 16, tileHeight: 16,
      tiles: [
        { id: 1, animation: [1, 2, 3] },
        { id: 2, animation: [2, 4], animationFrameDurationMs: 70 },
      ],
    });
    for (const tile of tileset.tiles) {
      const duration = tile.animationFrameDurationMs;
      Object.defineProperty(tile, "animationFrameDurationMs", { get: () => (lookups.count++, duration) });
    }
    let tilemap: TilemapPayload = { ...listing(tileset), chunkSize: 4 };
    for (let chunk = 0; chunk < chunks; chunk++) {
      for (let at = 0; at < tilesPerChunk; at++) {
        tilemap = setTile(tilemap, "layer-1", chunk * 4 + (at % 4), Math.floor(at / 4), 1 + (at % 2));
      }
    }
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    const meshes = root.getChildMeshes().filter((mesh) => mesh.name.endsWith(":anim"));
    lookups.count = 0;
    return { root, meshes, lookups, tileset };
  }

  /** The UVs the old per-tile path gives each chunk at `timeMs`: every quad shows its tile's frame for that time. */
  function expectedUvs(tileset: TilesetPayload, tilesPerChunk: number, timeMs: number): number[] {
    const frames = [[1, 2, 3][Math.floor(timeMs / 100) % 3]!, [2, 4][Math.floor(timeMs / 70) % 2]!];
    const uvs: number[] = [];
    for (let at = 0; at < tilesPerChunk; at++) {
      const uv = tilesetTileUv(tileset, frames[at % 2]!)!;
      uvs.push(uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1);
    }
    return uvs;
  }

  it("resolves an animated chunk once per distinct tile, and only when a frame boundary is crossed", () => {
    const { meshes, lookups } = animatedMap(3, 16);
    expect(meshes).toHaveLength(3);
    const uploads = meshes.map((mesh) => vi.spyOn(mesh, "updateVerticesData"));
    // A new chunk resolves once: its two distinct tiles, not its sixteen quads.
    updateSceneTilemapAnimations(scene, 0);
    expect(lookups.count).toBe(3 * 2 * 2);
    // No boundary before 70 ms: nothing is looked up or uploaded, whether time advances or holds (a paused game).
    lookups.count = 0;
    for (const time of [0, 16, 33, 50, 69, 69]) updateSceneTilemapAnimations(scene, time);
    expect(lookups.count).toBe(0);
    expect(uploads.every((upload) => upload.mock.calls.length === 0)).toBe(true);
    // Crossing the 70 ms boundary resolves each chunk once more and uploads its UVs once.
    updateSceneTilemapAnimations(scene, 70);
    expect(lookups.count).toBe(3 * 2 * 2);
    expect(uploads.map((upload) => upload.mock.calls.length)).toEqual([1, 1, 1]);
    updateSceneTilemapAnimations(scene, 99);
    expect(lookups.count).toBe(3 * 2 * 2);
  });

  it("shows every animated quad its tile's frame for the time, forwards, across boundaries, backwards and for a new chunk", () => {
    const { root, meshes, tileset } = animatedMap(2, 16);
    const uvs = (mesh: (typeof meshes)[number]) => [...mesh.getVerticesData(VertexBuffer.UVKind)!];
    // Dense forward steps cross every boundary of both durations (and their shared ones, 700 and 2100 ms).
    for (let time = 0; time <= 2200; time += 7) {
      updateSceneTilemapAnimations(scene, time);
      for (const mesh of meshes) expect(uvs(mesh), `at ${time} ms`).toEqual(expectedUvs(tileset, 16, time));
    }
    // Time going backwards (a restarted clock) inside what was a skipped span resolves again.
    for (const time of [2199, 150, 149, 0, 65, 10, Number.NaN, -5, 1e9 + 30]) {
      updateSceneTilemapAnimations(scene, time);
      const read = Number.isFinite(time) ? Math.max(0, time) : 0;
      for (const mesh of meshes) expect(uvs(mesh), `at ${time} ms`).toEqual(expectedUvs(tileset, 16, read));
    }
    // A chunk built while the clock stands inside a skipped span still gets that time's frames.
    updateSceneTilemapAnimations(scene, 240);
    const late = animatedMap(1, 8);
    updateSceneTilemapAnimations(scene, 240);
    expect(uvs(late.meshes[0]!)).toEqual(expectedUvs(late.tileset, 8, 240));
    root.dispose();
    late.root.dispose();
  });

  it("resolves at an inexact frame boundary exactly as a per-tile lookup does", () => {
    // 0.1 ms frames (a duration no float holds exactly): `step × 0.1` and `time / 0.1` both round, so boundaries are not exact.
    const tileset = normalizeTilesetPayload({
      atlasWidth: 64, atlasHeight: 16, tileWidth: 16, tileHeight: 16,
      tiles: [{ id: 1, animation: [1, 2, 3, 4] }],
    });
    // Normalizing keeps whole milliseconds; the lookup itself accepts any positive duration.
    tileset.tiles[0]!.animationFrameDurationMs = 0.1;
    const tilemap = setTile({ ...listing(tileset), chunkSize: 2 }, "layer-1", 0, 0, 1);
    const mesh = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1).getChildMeshes()[0]!;
    const bits = new BigUint64Array(1);
    const float = new Float64Array(bits.buffer);
    const neighbour = (value: number, by: bigint) => {
      float[0] = value;
      bits[0]! += by;
      return float[0];
    };
    for (let step = 1; step < 4000; step++) {
      // Inside the step before, then the floats just below, at and just above `step × 0.1`. The one just below
      // already reads the next frame at some steps (17, 34, 39 …), because `time / 0.1` rounds up to the step.
      const boundary = step * 0.1;
      for (const time of [boundary - 0.05, neighbour(boundary, -1n), boundary, neighbour(boundary, 1n)]) {
        updateSceneTilemapAnimations(scene, time);
        const uv = tilesetTileUv(tileset, [1, 2, 3, 4][Math.floor(time / 0.1) % 4]!)!;
        expect([...mesh.getVerticesData(VertexBuffer.UVKind)!], `at ${time} ms`).toEqual([uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1]);
      }
    }
  });

  /** Two parallax layers (and one world-locked) over `chunks` chunks each, under one root. */
  function parallaxMap(chunks: number) {
    const tileset = normalizeTilesetPayload({ atlasWidth: 16, atlasHeight: 16, tileWidth: 16, tileHeight: 16 });
    let tilemap: TilemapPayload = { ...listing(tileset), chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.flatMap((layer) => [
        { ...layer, parallax: { x: 0.5, y: 0.25 } },
        { ...layer, id: "layer-2", parallax: { x: 0, y: 2 } },
        { ...layer, id: "layer-3", parallax: { x: 1, y: 1 } },
      ]),
    };
    for (const layer of ["layer-1", "layer-2", "layer-3"]) {
      for (let chunk = 0; chunk < chunks; chunk++) tilemap = setTile(tilemap, layer, chunk * 2, 0, 1);
    }
    const root = createTilemapMeshes(scene, `actor-${scene.meshes.length}`, tilemap, atlas(tileset), 1, 1);
    const moving = root.getChildMeshes().filter((mesh) => !mesh.name.includes(":layer-3:"));
    const writes = moving.map((mesh) => vi.spyOn(mesh.position, "copyFrom"));
    const count = () => writes.reduce((sum, write) => sum + write.mock.calls.length, 0);
    return { root, moving, count, tileset, tilemap };
  }

  it("places parallax chunks only when the camera, a chunk parent's world matrix or the chunk set changes", () => {
    const { root, moving, count } = parallaxMap(5);
    expect(moving).toHaveLength(10);
    const transforms = vi.spyOn(Vector3, "TransformNormalToRef");
    updateSceneTilemapParallax(scene, { x: 10, y: 4 });
    expect(count()).toBe(10);
    // One offset per layer, not per chunk.
    expect(transforms).toHaveBeenCalledTimes(2);
    // A still camera over a still map writes nothing, frame after frame.
    for (let frame = 0; frame < 5; frame++) updateSceneTilemapParallax(scene, { x: 10, y: 4 });
    expect(count()).toBe(10);
    expect(transforms).toHaveBeenCalledTimes(2);
    // Each of these places every chunk again, once.
    updateSceneTilemapParallax(scene, { x: 10, y: 5 });
    expect(count()).toBe(20);
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(count()).toBe(30);
    root.rotation.z = 0.5;
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(count()).toBe(40);
    root.scaling.set(2, 3, 1);
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(count()).toBe(50);
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(count()).toBe(50);
    // A second map's chunks join: they are placed on the next update though nothing moved.
    const second = parallaxMap(2);
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(second.count()).toBe(4);
    updateSceneTilemapParallax(scene, { x: 11, y: 5 });
    expect(second.count()).toBe(4);
    transforms.mockRestore();
  });

  it("gives every parallax chunk the offset computed for it alone, for moved cameras and moved, rotated and scaled roots", () => {
    const first = parallaxMap(3);
    const second = parallaxMap(2);
    second.root.position.set(-4, 9, 0);
    // The offset a chunk gets by itself: the camera displacement, in its parent's space without translation.
    const expectPlaced = (camera: { x: number; y: number }) => {
      updateSceneTilemapParallax(scene, camera);
      for (const { root, moving } of [first, second]) {
        const inverse = root.computeWorldMatrix(true).clone().invert();
        for (const chunk of moving) {
          const parallax = chunk.metadata.tilemapParallax as { x: number; y: number };
          const offset = Vector3.TransformNormal(new Vector3(camera.x * (1 - parallax.x), camera.y * (1 - parallax.y), 0), inverse);
          expect(chunk.position.asArray(), chunk.name).toEqual(offset.asArray());
        }
      }
    };
    expectPlaced({ x: 10, y: 4 });
    expectPlaced({ x: 10, y: 4 });
    expectPlaced({ x: -3.5, y: 4 });
    first.root.rotation.z = 1.1;
    expectPlaced({ x: -3.5, y: 4 });
    second.root.scaling.set(0.5, 3, 1);
    expectPlaced({ x: -3.5, y: 4 });
    first.root.position.set(100, 0, 0);
    expectPlaced({ x: -3.5, y: 4 });
    first.root.rotation.z = 1.1 + 1e-9;
    expectPlaced({ x: -3.5, y: 4 });
    expectPlaced({ x: Number.NaN, y: 4 });
    expectPlaced({ x: 0, y: 0 });
    // Disposing one map leaves the other placed as before and still following the camera.
    first.root.dispose();
    first.moving.length = 0;
    expectPlaced({ x: 0, y: 0 });
    expectPlaced({ x: 6, y: -2 });
  });

  it("stores per-layer parallax on chunk meshes", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = listing(tileset);
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.flatMap((layer) => [
        { ...layer, parallax: { x: 0.5, y: 0.25 } },
        // A layer that scrolls with the camera on X still follows parallax on Y.
        { ...layer, id: "layer-2", parallax: { x: 1, y: 0.5 } },
      ]),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    tilemap = setTile(tilemap, "layer-2", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    const [child, vertical] = root.getChildMeshes();
    expect(child!.metadata?.tilemapParallax).toEqual({ x: 0.5, y: 0.25 });
    updateSceneTilemapParallax(scene, { x: 10, y: 4 });
    expect(child!.position.x).toBeCloseTo(5, 6);
    expect(child!.position.y).toBeCloseTo(3, 6);
    expect(vertical!.position.x).toBeCloseTo(0, 6);
    expect(vertical!.position.y).toBeCloseTo(2, 6);

    // The offset is a world displacement: a scaled tilemap root must not stretch it.
    root.position.set(7, -3, 0);
    root.scaling.set(2, 4, 1);
    updateSceneTilemapParallax(scene, { x: 10, y: 4 });
    child!.computeWorldMatrix(true);
    const world = child!.getAbsolutePosition();
    expect(world.x - root.position.x).toBeCloseTo(5, 6);
    expect(world.y - root.position.y).toBeCloseTo(3, 6);
  });

  it("sits an unbounded map's pivot on the root, negative chunks included, with parallax and sorting still applied", () => {
    const tileset = normalizeTilesetPayload({ atlasWidth: 16, atlasHeight: 16, tileWidth: 16, tileHeight: 16 });
    let tilemap: TilemapPayload = { ...listing(tileset), chunkSize: 2, unbounded: true, pivot: { x: -1.5, y: 2 } };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({ ...layer, sortingLayer: "Foreground", parallax: { x: 0.5, y: 1 } })),
    };
    // Cell (-3, 1): chunk (-2, 0).
    tilemap = setTile(tilemap, "layer-1", -3, 1, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 2, 3);
    root.position.set(10, 20, 0);
    const chunk = root.getChildMeshes().find((mesh) => mesh.name === "actor-0:layer-1:-2:0")!;
    expect(chunk).toBeTruthy();
    // Sorted as a layer of the map, though it hangs under the pivot node.
    expect(chunk.metadata.sortingGroupId).toBe("actor-0");
    expect(chunk.metadata.sortingLayerKey).toBeGreaterThan(0);
    const bounds = () => {
      chunk.computeWorldMatrix(true);
      const { minimumWorld: min, maximumWorld: max } = chunk.getBoundingInfo().boundingBox;
      return [min.x, min.y, max.x, max.y].map((value) => Math.round(value * 1000) / 1000);
    };
    // Cell -3..-2 × 1..2 less the pivot (-1.5, 2), times the 2 × 3 tile, from the root at (10, 20).
    expect(bounds()).toEqual([10 - 3, 20 - 3, 10 - 1, 20]);
    // Parallax writes the chunk's own offset, on top of the pivot.
    updateSceneTilemapParallax(scene, { x: 8, y: 0 });
    expect(bounds()).toEqual([10 - 3 + 4, 20 - 3, 10 - 1 + 4, 20]);
  });

  it("skips hidden layers", () => {
    const tileset = normalizeTilesetPayload({
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = listing(tileset);
    tilemap = { ...tilemap, chunkSize: 2 };
    tilemap = {
      ...tilemap,
      layers: tilemap.layers.map((layer) => ({ ...layer, visible: false })),
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    const root = createTilemapMeshes(scene, "actor-0", tilemap, atlas(tileset), 1, 1);
    expect(root.getChildMeshes()).toHaveLength(0);
  });

  it("splits a chunk into one child mesh per atlas", () => {
    const ground = normalizeTilesetPayload({
      textureGuid: "ground-tex",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    const deco = normalizeTilesetPayload({
      textureGuid: "deco-tex",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
    });
    let tilemap = createDefaultTilemapPayload();
    tilemap = {
      ...tilemap,
      chunkSize: 2,
      tilesets: [
        { guid: "ground", firstGid: 1, tileCount: 1 },
        { guid: "deco", firstGid: 2, tileCount: 1 },
      ],
    };
    tilemap = setTile(tilemap, "layer-1", 0, 0, 1);
    tilemap = setTile(tilemap, "layer-1", 1, 0, 2);
    const root = createTilemapMeshes(
      scene,
      "actor-0",
      tilemap,
      new Map([
        ["ground", ground],
        ["deco", deco],
      ]),
      1,
      1,
    );
    const children = root.getChildMeshes();
    expect(children).toHaveLength(2);
    const textures = children.map(
      (mesh) => mesh.metadata?.tilemapTextureGuid as string,
    );
    expect(textures.sort()).toEqual(["deco-tex", "ground-tex"]);
    const missingGround = createTilemapMeshes(scene, "missing-ground", tilemap, new Map([["deco", deco]]), 1, 1);
    expect(missingGround.getChildMeshes()).toHaveLength(1);
    expect(missingGround.getChildMeshes()[0]!.getTotalVertices()).toBe(4);
    expect(missingGround.getChildMeshes()[0]!.metadata.tilemapTextureGuid).toBe("deco-tex");
  });
});

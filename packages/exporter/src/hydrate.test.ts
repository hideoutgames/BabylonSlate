import { describe, expect, it } from "vitest";
import { DEFAULT_COLLISION_PRESETS, DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { createDefaultSpriteAnimationPayload, getTile, TERRAIN_E, TERRAIN_W } from "@haptic/assets";
import { createDefaultMaterialDocument, createDefaultMaterialInstanceDocument } from "@haptic/shader-graph";
import { packedContentFromGame, packedSourceControls } from "./hydrate";
import { gameSourceSubset, type GameSourceContent } from "./source-content";
import type { GameAssetIndexEntry } from "./types";

const encoder = new TextEncoder();

function sources(assets: GameAssetIndexEntry[], payloads: Record<string, unknown> = {}): GameSourceContent {
  return {
    manifest: {
      assetCatalogVersion: 1, startupSceneGuid: "scene", globalFallback: "sans-serif", bundleDebugger: false, render: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60, garbageCollectionIntervalTicks: 60, pixelsPerUnit: 100, pixelPerfect: false, nearestTextures: false, sortingLayers: ["Default"], physicsWorld: "2d", collisionPresets: [...DEFAULT_COLLISION_PRESETS], assets,
    },
    scripts: [], scenes: new Map(), sceneLayers: new Map(), textureBytes: new Map(), areaEmissions: new Map(),
    modelBytes: new Map(), modelPayloads: new Map(), complexMeshes: new Map(), fontBytes: new Map(), fontFacetypeBytes: new Map(),
    fontMsdfJson: new Map(), fontMsdfPng: new Map(), fontFamilies: new Map(), audioBytes: new Map(), audioPayloads: new Map(),
    payloads: new Map(Object.entries(payloads).map(([guid, payload]) => [guid, encoder.encode(JSON.stringify(payload))])),
    navmeshBytes: new Map(), audioReverbBytes: new Map(),
  };
}

describe("packedContentFromGame", () => {
  it("sizes Sprite Animation frames from the catalog's authored Texture size when the texture is not a PNG", () => {
    const animation = { ...createDefaultSpriteAnimationPayload(), frames: [{ textureGuid: "walk", durationMs: 100 }] };
    const game = sources([
      { guid: "walk", type: "Texture", encoding: "bytes", width: 64, height: 32 },
      { guid: "walk-anim", type: "SpriteAnimation", encoding: "json" },
    ], { "walk-anim": animation });
    game.textureBytes.set("walk", new Uint8Array([0xab, 0x4b, 0x54, 0x58]));
    expect(packedContentFromGame(game).spriteAnimationPayloads.get("walk-anim")?.frames[0]).toMatchObject({ width: 64, height: 32 });
  });

  it("resolves Sprite frames from their Sprite and sheet cells from the sheet Texture's grid", () => {
    const game = sources([
      { guid: "hero-tex", type: "Texture", encoding: "bytes", width: 48, height: 96 },
      { guid: "sheet-tex", type: "Texture", encoding: "bytes", width: 64, height: 32 },
      { guid: "hero", type: "Sprite", encoding: "json" },
      { guid: "walk-anim", type: "SpriteAnimation", encoding: "json" },
      { guid: "run-anim", type: "SpriteAnimation", encoding: "json" },
    ], {
      hero: { textureGuid: "hero-tex", pivot: { x: 0.5, y: 1 }, collision: { x: 0.25, y: 0, width: 0.5, height: 1 } },
      "walk-anim": { frames: [{ spriteGuid: "hero" }] },
      "run-anim": { source: "sheet", sheet: { textureGuid: "sheet-tex", cellWidth: 32, cellHeight: 32 }, frames: [{ cell: 2 }] },
    });
    const content = packedContentFromGame(game);
    expect(content.spriteAnimationPayloads.get("walk-anim")?.frames[0]).toMatchObject({
      spriteGuid: "hero",
      textureGuid: "hero-tex",
      width: 48,
      height: 96,
      pivot: { x: 0.5, y: 1 },
      collision: { x: 0.25, y: 0, width: 0.5, height: 1 },
    });
    expect(content.spriteAnimationPayloads.get("run-anim")?.frames[0]).toMatchObject({
      textureGuid: "sheet-tex",
      width: 32,
      height: 32,
      uv: { u0: 0.5 + 0.5 / 64, u1: 1 - 0.5 / 64 },
    });
  });

  it("sizes each Sprite from its Texture's catalog size, which the packed player quad and collider use", () => {
    const game = sources([
      { guid: "hero-tex", type: "Texture", encoding: "bytes", width: 48, height: 96 },
      { guid: "hero", type: "Sprite", encoding: "json" },
    ], { hero: { textureGuid: "hero-tex", pixelsPerUnit: 32, pivot: { x: 0.5, y: 1 } } });
    game.textureBytes.set("hero-tex", new Uint8Array([0xab, 0x4b, 0x54, 0x58]));
    expect(packedContentFromGame(game).spritePayloads.get("hero")).toEqual({
      textureGuid: "hero-tex",
      pixelsPerUnit: 32,
      pivot: { x: 0.5, y: 1 },
      collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 48,
      height: 96,
    });
  });

  it("packs each Tilemap with its autotile cells as its current Tileset resolves them", () => {
    // A ledge saved as single pieces before the Tileset had its end and middle pieces.
    const game = sources([
      { guid: "ledges", type: "Tileset", encoding: "json" },
      { guid: "level", type: "Tilemap", encoding: "json" },
    ], {
      ledges: {
        atlasWidth: 64,
        terrains: [{ id: "ledge", name: "Ledge", style: "sides" }],
        tiles: [0, TERRAIN_E, TERRAIN_E | TERRAIN_W, TERRAIN_W].map((mask, at) => ({ id: at + 1, terrain: { id: "ledge", mask } })),
      },
      level: {
        tilesets: [{ guid: "ledges", firstGid: 1, tileCount: 4 }],
        width: 5,
        height: 1,
        layers: [{ id: "layer-1", chunks: [{ cx: 0, cy: 0, tiles: [0, 1, 1, 1] }] }],
      },
    });
    const level = packedContentFromGame(game).tilemapPayloads.get("level")!;
    expect([1, 2, 3].map((x) => getTile(level, "layer-1", x, 0))).toEqual([2, 3, 4]);
  });

  it("keeps a held payload's documents across refreshes and normalizes a replaced payload again", () => {
    const game = sources([
      { guid: "wall", type: "Material", name: "Wall", encoding: "json" },
      { guid: "red-wall", type: "MaterialInstance", name: "Red Wall", encoding: "json" },
    ], { wall: createDefaultMaterialDocument("Wall"), "red-wall": createDefaultMaterialInstanceDocument("Red Wall", "wall") });
    const first = packedContentFromGame(game);
    const refreshed = packedContentFromGame(game);
    // The same payloads keep their documents, which the Material lowering cache is keyed on.
    expect(refreshed.materialDocuments.get("wall")).toBe(first.materialDocuments.get("wall"));
    expect(refreshed.materialDocuments.get("red-wall")).toBe(first.materialDocuments.get("red-wall"));
    // A re-acquired Material arrives as a new payload: it and the instance materialized from it follow it.
    game.payloads.set("wall", encoder.encode(JSON.stringify({ ...createDefaultMaterialDocument("Wall"), alphaCutoff: 0.25 })));
    const reacquired = packedContentFromGame(game);
    expect(reacquired.materialDocuments.get("wall")).toMatchObject({ name: "Wall", alphaCutoff: 0.25 });
    expect(reacquired.materialDocuments.get("red-wall")).toMatchObject({ name: "Red Wall", instanceOf: "wall", alphaCutoff: 0.25 });
  });

  it("names data type schemas after their catalog entries", () => {
    const game = sources([{ guid: "stats", type: "Structure", name: "Weapon Stats", encoding: "json" }],
      { stats: { fields: [{ name: "Power", typeId: "int" }] } });
    expect(packedContentFromGame(game).dataAssets).toMatchObject([{ guid: "stats", name: "Weapon Stats" }]);
  });

  it("packs 2D and 3D Timeline Clip assets for Create, without their Editor Preview", () => {
    const swing = {
      timelineAsset: "story", length: 2,
      proxies: [{ id: "door", name: "Door", represents: "actor", classId: "Door", tracks: [] }],
      eventTracks: [],
      editorPreview: { proxies: { door: { representation: "model", assetGuid: "door-model" } } },
    };
    const game = sources([{ guid: "swing", type: "TimelineClip3D", name: "Door Swing", encoding: "json" }], { swing });
    const content = packedContentFromGame(game);
    expect(content.timelineClipAssets).toMatchObject([{ guid: "swing", type: "TimelineClip3D", name: "Door Swing", payload: { timelineAsset: "story", length: 2 } }]);
    expect(content.timelineClipAssets[0]!.payload).not.toHaveProperty("editorPreview");
    const load = packedSourceControls(game, content).find((control) => control.type === "loadSceneContent");
    expect(load).toMatchObject({ timelineClipAssets: [{ guid: "swing" }] });
  });
});

describe("gameSourceSubset", () => {
  it("keeps an asset's unpacked audio clips and owned sidecars and lists only the selected catalog entries", () => {
    const game = sources([
      { guid: "jump", type: "Audio", encoding: "bytes" },
      { guid: "navmesh:scene", type: "NavMesh", encoding: "bytes" },
      { guid: "other", type: "Audio", encoding: "bytes" },
      { guid: "jumps", type: "Audio", encoding: "bytes" },
    ]);
    for (const key of ["jump", "jump:source", "jump:loop", "other:source", "jumps"]) game.audioBytes.set(key, new Uint8Array([1]));
    game.navmeshBytes.set("scene", new Uint8Array([2]));
    const subset = gameSourceSubset(game, new Set(["jump", "navmesh:scene"]));
    expect([...subset.audioBytes.keys()]).toEqual(["jump", "jump:source", "jump:loop"]);
    expect([...subset.navmeshBytes.keys()]).toEqual(["scene"]);
    expect(subset.manifest.assets.map(entry => entry.guid)).toEqual(["jump", "navmesh:scene"]);
  });
});

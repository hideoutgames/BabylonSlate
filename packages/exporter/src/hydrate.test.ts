import { describe, expect, it } from "vitest";
import { DEFAULT_COLLISION_PRESETS, DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { createDefaultSpriteAnimationPayload } from "@haptic/assets";
import { packedContentFromGame } from "./hydrate";
import { gameSourceSubset, type GameSourceContent } from "./source-content";
import type { GameAssetIndexEntry } from "./types";

const encoder = new TextEncoder();

function sources(assets: GameAssetIndexEntry[], payloads: Record<string, unknown> = {}): GameSourceContent {
  return {
    manifest: {
      assetCatalogVersion: 1, startupSceneGuid: "scene", bundleDebugger: false, render: DEFAULT_RENDER_PROJECT_SETTINGS,
      playFrameCap: 60, pixelsPerUnit: 100, pixelPerfect: false, sortingLayers: ["Default"], physicsWorld: "2d", collisionPresets: [...DEFAULT_COLLISION_PRESETS], assets,
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

  it("names data type schemas after their catalog entries", () => {
    const game = sources([{ guid: "stats", type: "Structure", name: "Weapon Stats", encoding: "json" }],
      { stats: { fields: [{ name: "Power", typeId: "int" }] } });
    expect(packedContentFromGame(game).dataAssets).toMatchObject([{ guid: "stats", name: "Weapon Stats" }]);
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

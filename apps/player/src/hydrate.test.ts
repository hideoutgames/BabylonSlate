import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  DEFAULT_RENDER_PROJECT_SETTINGS,
} from "@babylonslate/core";
import { exportGame, navmeshExportGuid } from "@babylonslate/exporter";
import { loadGameFromFiles } from "./artifact";
import { packedContentFromGame, packedPlayControls } from "./hydrate";

describe("packedContentFromGame", () => {
  it("hydrates sprite, tilemap, and navmesh payloads from the packed game", async () => {
    const scene = {
      ...createDefaultScene(),
      name: "Arena",
    };
    const sprite = {
      textureGuid: "tex-1",
      pixelsPerUnit: 100,
      frames: [
        {
          name: "idle",
          u: 0,
          v: 0,
          uSize: 1,
          vSize: 1,
          durationMs: 100,
          pivot: { x: 0.5, y: 0.5 },
        },
      ],
      clips: [{ name: "Idle", frames: ["idle"] }],
    };
    const tilemap = {
      tilesetGuid: "tileset-1",
      tileWidth: 16,
      tileHeight: 16,
      chunkSize: 32,
      layers: [],
    };
    const tileset = {
      textureGuid: "tex-1",
      atlasWidth: 16,
      atlasHeight: 16,
      tileWidth: 16,
      tileHeight: 16,
      margin: 0,
      spacing: 0,
      tiles: [],
    };
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: "scene-1",
      customResolution: DEFAULT_RENDER_PROJECT_SETTINGS,
      pixelsPerUnit: 50,
      scripts: [],
      assets: [
        {
          guid: "scene-1",
          type: "Scene",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(scene)),
        },
        {
          guid: "sprite-1",
          type: "Sprite",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(sprite)),
        },
        {
          guid: "tilemap-1",
          type: "Tilemap",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(tilemap)),
        },
        {
          guid: "tileset-1",
          type: "Tileset",
          sceneGuid: "scene-1",
          bytes: new TextEncoder().encode(JSON.stringify(tileset)),
        },
        {
          guid: navmeshExportGuid("scene-1"),
          type: "NavMesh",
          sceneGuid: "scene-1",
          bytes: new Uint8Array([4, 5, 6]),
        },
      ],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const game = await loadGameFromFiles(packed.value.files);
    const content = packedContentFromGame(game);
    expect(content.spritePayloads.get("sprite-1")?.textureGuid).toBe("tex-1");
    expect(content.tilemapPayloads.get("tilemap-1")?.tilesetGuid).toBe("tileset-1");
    expect(content.tilesetPayloads.get("tileset-1")?.textureGuid).toBe("tex-1");
    expect(content.navmeshBytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(content.pixelsPerUnit).toBe(50);
    expect(content.pixelPerfect).toBe(false);
    const controls = packedPlayControls(content);
    expect(controls.some((entry) => entry.type === "loadTilemaps")).toBe(true);
    expect(controls.some((entry) => entry.type === "loadNavMesh")).toBe(true);
  });
});

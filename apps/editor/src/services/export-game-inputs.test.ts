import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import type { IndexedAsset } from "@babylonslate/assets";
import { loadExportDocuments } from "./export-game-inputs";

function textureAsset(): IndexedAsset {
  return {
    rootId: "project",
    path: "assets/Hero.texture.babasset",
    header: {
      guid: "tex-1",
      type: "Texture",
      name: "Hero",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      payload: {},
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          sha256: "aa",
          locator: { inline: { offset: 0, length: 1 } },
        },
        {
          id: "ktx2:hash",
          kind: "ktx2",
          mime: "image/ktx2",
          sha256: "bb",
          locator: { inline: { offset: 1, length: 1 } },
        },
      ],
    },
  };
}

describe("loadExportDocuments", () => {
  it("serializes scenes as JSON and packs the KTX2 texture chunk", async () => {
    const scene = createDefaultScene();
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/main.scene.babasset",
          header: {
            guid: "scene-1",
            type: "Scene",
            name: "Main",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: {},
            chunks: [],
          },
        },
        textureAsset(),
      ],
      loadDocument: async (kind) => {
        expect(kind).toBe("scene");
        return scene;
      },
      readAssetChunk: async (_path, chunkId) => {
        if (chunkId === "ktx2:hash") return new Uint8Array([9, 9]);
        if (chunkId === "pixels") return new Uint8Array([1]);
        return null;
      },
    });
    expect(loaded.sceneByGuid("scene-1")?.name).toBe(scene.name);
    expect(loaded.bytesByGuid("tex-1")).toEqual(new Uint8Array([9, 9]));
    expect(JSON.parse(new TextDecoder().decode(loaded.bytesByGuid("scene-1")!)).name).toBe(
      scene.name,
    );
  });
});

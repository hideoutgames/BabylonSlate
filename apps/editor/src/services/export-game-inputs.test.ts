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
    expect(loaded.guiImageBytesByGuid("tex-1")).toEqual(new Uint8Array([1]));
    expect(JSON.parse(new TextDecoder().decode(loaded.bytesByGuid("scene-1")!)).name).toBe(
      scene.name,
    );
  });

  it("packs the authored ktx2 hash, not the first ktx2 chunk", async () => {
    const loaded = await loadExportDocuments({
      assets: [
        {
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
            payload: { ktx2ChunkId: "ktx2:authored" },
            chunks: [
              {
                id: "pixels",
                kind: "pixels",
                mime: "image/png",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 1 } },
              },
              {
                id: "ktx2:stale",
                kind: "ktx2",
                mime: "image/ktx2",
                sha256: "old",
                locator: { inline: { offset: 1, length: 1 } },
              },
              {
                id: "ktx2:authored",
                kind: "ktx2",
                mime: "image/ktx2",
                sha256: "new",
                locator: { inline: { offset: 2, length: 1 } },
              },
            ],
          },
        },
      ],
      loadDocument: async () => null,
      readAssetChunk: async (_path, chunkId) => {
        if (chunkId === "ktx2:authored") return new Uint8Array([7, 7]);
        if (chunkId === "ktx2:stale") return new Uint8Array([3, 3]);
        if (chunkId === "pixels") return new Uint8Array([1]);
        return null;
      },
    });
    expect(loaded.bytesByGuid("tex-1")).toEqual(new Uint8Array([7, 7]));
  });

  it("exposes sprite document payloads for the export closure", async () => {
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Hero.sprite.babasset",
          header: {
            guid: "sprite-1",
            type: "Sprite",
            name: "Hero",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: {},
            chunks: [],
          },
        },
      ],
      loadDocument: async () => ({ textureGuid: "tex-atlas" }),
      readAssetChunk: async () => null,
    });
    expect(loaded.payloadByGuid("sprite-1")).toEqual({ textureGuid: "tex-atlas" });
  });

  it("reads the Scene navmesh extra chunk for packed Play", async () => {
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
            chunks: [
              {
                id: "navmesh",
                kind: "bytes",
                mime: "application/octet-stream",
                sha256: "cc",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
          },
        },
      ],
      loadDocument: async () => scene,
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "navmesh" ? new Uint8Array([1, 2, 3]) : null,
    });
    expect(loaded.navmeshByGuid("scene-1")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads the Scene audioReverb extra chunk for packed Play", async () => {
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
            chunks: [
              {
                id: "audioReverb",
                kind: "bytes",
                mime: "application/octet-stream",
                sha256: "ee",
                locator: { inline: { offset: 0, length: 2 } },
              },
            ],
          },
        },
      ],
      loadDocument: async () => scene,
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "audioReverb" ? new Uint8Array([9, 8]) : null,
    });
    expect(loaded.audioReverbByGuid("scene-1")).toEqual(new Uint8Array([9, 8]));
  });

  it("loads Font documents into payloads without replacing source bytes", async () => {
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Display.font.babasset",
          header: {
            guid: "font-1",
            type: "Font",
            name: "Custom Font",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: {},
            chunks: [
              {
                id: "source",
                kind: "bytes",
                mime: "font/ttf",
                sha256: "dd",
                locator: { inline: { offset: 0, length: 3 } },
              },
            ],
          },
        },
      ],
      loadDocument: async (kind) => {
        expect(kind).toBe("font");
        return { family: "Display" };
      },
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "source" ? new Uint8Array([7, 8, 9]) : null,
    });
    expect(loaded.payloadByGuid("font-1")).toEqual({ family: "Display" });
    expect(loaded.bytesByGuid("font-1")).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("packs Audio source with payload so the player can route gain", async () => {
    const { decodePackedAudioAsset } = await import("@babylonslate/assets");
    const kinds: string[] = [];
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Jump.babasset",
          header: {
            guid: "jump",
            type: "Audio",
            name: "Jump",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: { volume: 0.5, audioChannelGuid: "sfx" },
            chunks: [
              {
                id: "source",
                kind: "audio",
                mime: "audio/wav",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 4 } },
              },
            ],
          },
        },
      ],
      loadDocument: async (kind) => {
        kinds.push(kind);
        return { volume: 0.5, audioChannelGuid: "sfx", soundAttenuationGuid: null };
      },
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "source" ? new Uint8Array([1, 2, 3, 4]) : null,
    });
    expect(kinds).toEqual(["audio"]);
    const packed = loaded.bytesByGuid("jump");
    expect(packed).toBeTruthy();
    expect(decodePackedAudioAsset(packed!)).toEqual({
      payload: {
        volume: 0.5,
        audioChannelGuid: "sfx",
        soundAttenuationGuid: null,
        clips: [{ chunkId: "source", name: "", weight: 1 }],
        pitch: 1,
        pitchRandom: false,
        pitchMin: 1,
        pitchMax: 1,
        loop: false,
      },
      source: new Uint8Array([1, 2, 3, 4]),
      sources: [new Uint8Array([1, 2, 3, 4])],
    });
  });

  it("packs every Audio clip blob, not only the default source chunk", async () => {
    const { decodePackedAudioAsset } = await import("@babylonslate/assets");
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Jump.babasset",
          header: {
            guid: "jump",
            type: "Audio",
            name: "Jump",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: {
              clips: [
                { chunkId: "source", name: "a", weight: 1 },
                { chunkId: "source:2", name: "b", weight: 1 },
              ],
            },
            chunks: [
              {
                id: "source",
                kind: "audio",
                mime: "audio/wav",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 3 } },
              },
              {
                id: "source:2",
                kind: "audio",
                mime: "audio/wav",
                sha256: "bb",
                locator: { inline: { offset: 0, length: 2 } },
              },
            ],
          },
        },
      ],
      loadDocument: async () => ({
        clips: [
          { chunkId: "source", name: "a", weight: 1 },
          { chunkId: "source:2", name: "b", weight: 1 },
        ],
      }),
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "source"
          ? new Uint8Array([1, 2, 3])
          : chunkId === "source:2"
            ? new Uint8Array([9, 8])
            : null,
    });
    const packed = loaded.bytesByGuid("jump");
    expect(decodePackedAudioAsset(packed!)?.sources).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([9, 8]),
    ]);
  });

  it("serializes Animation payloads as JSON for packed Play", async () => {
    const payload = {
      clipName: "Idle",
      modelGuid: "hero-model",
      skeletonGuid: "hero-skel",
      durationMs: 1800,
    };
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Hero_Idle.animation.babasset",
          header: {
            guid: "hero-idle-anim",
            type: "Animation",
            name: "Hero_Idle",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: ["hero-model", "hero-skel"],
            payload,
            chunks: [],
          },
        },
      ],
      loadDocument: async (kind) => {
        expect(kind).toBe("animation");
        return payload;
      },
      readAssetChunk: async () => null,
    });
    expect(loaded.payloadByGuid("hero-idle-anim")).toEqual(payload);
    expect(JSON.parse(new TextDecoder().decode(loaded.bytesByGuid("hero-idle-anim")!))).toEqual(
      payload,
    );
  });

  it("exposes Font facetype-glyphs chunks separately from Font source bytes", async () => {
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Display.font.babasset",
          header: {
            guid: "font-1",
            type: "Font",
            name: "Display",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: { family: "Display" },
            chunks: [
              {
                id: "source",
                kind: "font",
                mime: "font/woff2",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 2 } },
              },
              {
                id: "facetype-glyphs",
                kind: "font-facetype",
                mime: "application/json",
                sha256: "bb",
                locator: { inline: { offset: 2, length: 3 } },
              },
            ],
          },
        },
      ],
      loadDocument: async () => ({ family: "Display" }),
      readAssetChunk: async (_path, chunkId) => {
        if (chunkId === "source") return new Uint8Array([1, 2]);
        if (chunkId === "facetype-glyphs") return new Uint8Array([9, 8, 7]);
        return null;
      },
    });
    expect(loaded.bytesByGuid("font-1")).toEqual(new Uint8Array([1, 2]));
    expect(loaded.fontFacetypeBytesByGuid("font-1")).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("packs Model payload with GLB source so importScale survives export", async () => {
    const { decodePackedModelAsset } = await import("@babylonslate/assets");
    const kinds: string[] = [];
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 9, 8]);
    const loaded = await loadExportDocuments({
      assets: [
        {
          rootId: "project",
          path: "assets/Hero.model.babasset",
          header: {
            guid: "hero-model",
            type: "Model",
            name: "Hero",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: { importScale: 1, clipNames: [] },
            chunks: [
              {
                id: "source",
                kind: "geometry",
                mime: "model/gltf-binary",
                sha256: "aa",
                locator: { inline: { offset: 0, length: 6 } },
              },
            ],
          },
        },
      ],
      loadDocument: async (kind) => {
        kinds.push(kind);
        return {
          importScale: 4,
          clipNames: ["Walk"],
          materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
          skeletonGuid: "skel-1",
        };
      },
      readAssetChunk: async (_path, chunkId) =>
        chunkId === "source" ? glb : null,
    });
    expect(kinds).toEqual(["model"]);
    const packed = loaded.bytesByGuid("hero-model");
    expect(packed).toBeTruthy();
    expect(decodePackedModelAsset(packed!)).toEqual({
      payload: {
        importScale: 4,
        clipNames: ["Walk"],
        materialSlots: [{ index: 0, name: "Body", materialGuid: "mat-1" }],
        skeletonGuid: "skel-1",
      },
      source: glb,
    });
    expect(loaded.payloadByGuid("hero-model")).toMatchObject({ importScale: 4 });
  });
});

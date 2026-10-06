import { describe, expect, it } from "vitest";
import { createEmptyProject } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  AssetRegistry, buildBoxGlbFixture, createRegistryAssetLoadingService, encodeBabasset,
  FONT_FACETYPE_CHUNK_ID, projectContentRoot, type ChunkInput,
} from "@babylonslate/assets";
import { acquirePlayAssetSources, emptyPlaySourceControls, mergePreparedPlaySources } from "./play-asset-sources";

describe("Play source ownership", () => {
  it("selects active font/audio representations and shares model decoding across different scene instances", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const write = async (guid: string, type: string, payload: Record<string, unknown>, chunks: ChunkInput[], required: string[] = []) => {
      await storage.writeBinary(`assets/${guid}.babasset`, await encodeBabasset({
        header: {
          guid, name: guid, type, version: 1, engineVersion: "0.0.0", mode: "thin", payload,
          dependencies: required, requiredDependencies: required, dependencyMetadataVersion: 1,
        }, chunks,
      }));
    };
    const document = new TextEncoder().encode(JSON.stringify({ name: "Scene", actors: [{
      id: "text", name: "Label", components: [{ id: "label", classId: "Text3DComponent", properties: { fontAssetGuid: "font" } }],
    }] }));
    for (const id of ["scene-a", "scene-b"]) await write(id, "Scene", {}, [
      { id: "document", kind: "document", mime: "application/json", data: document },
    ], ["model", "audio", "font"]);
    const model = buildBoxGlbFixture();
    await write("model", "Model", {}, [{ id: "source", kind: "model", mime: "model/gltf-binary", data: model }]);
    await write("audio", "Audio", { clips: [
      { chunkId: "source", name: "One", weight: 1 }, { chunkId: "second", name: "Two", weight: 1 },
    ] }, [
      { id: "source", kind: "audio", mime: "audio/wav", data: new Uint8Array([1, 2]) },
      { id: "second", kind: "audio", mime: "audio/wav", data: new Uint8Array([3, 4, 5]) },
      { id: "unused", kind: "audio", mime: "audio/wav", data: new Uint8Array(1000) },
    ]);
    await write("font", "Font", { family: "Test", representations: { facetype: true, source: true } }, [
      { id: FONT_FACETYPE_CHUNK_ID, kind: "font", mime: "application/json", data: new Uint8Array([123, 125]) },
      { id: "source", kind: "font", mime: "font/ttf", data: new Uint8Array(1000) },
    ]);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loading = createRegistryAssetLoadingService(registry, { projectId: "play" });
    const host = {
      registry, project: createEmptyProject("Play"), createScope: (owner: string) => loading.createScope(owner),
      compile: async () => ({ bundles: [], diagnostics: [] }),
    };
    const before = storage.getReadMetrics().actualBytesRead;
    const first = await acquirePlayAssetSources(host, ["scene-a"], { consumer: "Scene A", signal: new AbortController().signal });
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(document.byteLength + model.byteLength + 7);
    expect(first.audioChunks.get("audio")?.get("second")).toEqual(new Uint8Array([3, 4, 5]));
    expect(first.game.fontBytes.size).toBe(0);
    expect(first.game.fontFacetypeBytes.has("font")).toBe(true);
    expect(first.content.complexMeshes.get("model")?.vertices.length).toBeGreaterThan(0);
    const second = await acquirePlayAssetSources(host, ["scene-b"], { consumer: "Scene B", signal: new AbortController().signal });
    expect(second.content.complexMeshes.get("model")).toBe(first.content.complexMeshes.get("model"));
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(document.byteLength * 2 + model.byteLength + 7);
    const merged = mergePreparedPlaySources([first, second])!;
    expect(merged.game.scenes.size).toBe(2);
    expect(merged.content.complexMeshes.get("model")).toBe(second.content.complexMeshes.get("model"));
    expect(merged.controls.some((control) => control.type === "loadModels")).toBe(true);
    first.release();
    loading.trim({ force: true });
    expect(second.content.complexMeshes.get("model")?.vertices.length).toBeGreaterThan(0);
    second.release();
    loading.trim({ force: true });
    expect(loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    expect(emptyPlaySourceControls()).toContainEqual({ type: "loadModels", models: [], complexMeshes: [] });
    loading.dispose();
  });
});

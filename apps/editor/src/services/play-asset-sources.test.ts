import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  AssetRegistry, buildBoxGlbFixture, createRegistryAssetLoadingService, encodeBabasset,
  FONT_FACETYPE_CHUNK_ID, projectContentRoot, type ChunkInput,
} from "@babylonslate/assets";
import { acquirePlayAssetSources, emptyPlaySourceControls, mergePreparedPlaySources, requiredProjectAssets } from "./play-asset-sources";

describe("Play source ownership", () => {
  it("shares compatible scoped compilation across scenes and evicts its code after the final owner", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    for (const id of ["scene-a", "scene-b", "script"]) await storage.writeBinary(`assets/${id}.babasset`, await encodeBabasset({
      header: {
        guid: id, name: id, type: id === "script" ? "Class" : "Scene", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: id === "script" ? [] : ["script"], requiredDependencies: id === "script" ? [] : ["script"], dependencyMetadataVersion: 1,
        payload: id === "script" ? { nodes: [], edges: [], members: [] } : { actors: [] },
      }, chunks: [],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loading = createRegistryAssetLoadingService(registry, { projectId: "scripts" });
    const source = "export function start() {}";
    const compile = vi.fn(async () => {
      await Promise.resolve();
      return { bundles: [{ assetGuid: "script", classId: "Shared", source, anchors: [], entryPoints: [] }], diagnostics: [] };
    });
    const host = { registry, project: createEmptyProject("Scripts"), createScope: (owner: string) => loading.createScope(owner), compile };
    const [first, second] = await Promise.all(["scene-a", "scene-b"].map(guid => acquirePlayAssetSources(host, [guid], {
      consumer: guid, signal: new AbortController().signal,
    })));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(second.game.scripts).toBe(first.game.scripts);
    expect(loading.snapshot().entries.find(entry => entry.representation.startsWith("play-scripts:"))?.decodedBytes).toBeGreaterThan(source.length * 2);
    const bundles = second.game.scripts;
    expect(mergePreparedPlaySources([first, second])?.controls.filter(control => control.type === "loadScripts")).toHaveLength(1);
    first.release();
    loading.trim({ force: true });
    expect(first.game.scripts).toEqual([]);
    expect(first.controls).toEqual([]);
    expect(second.game.scripts).toHaveLength(1);
    second.release();
    const warmed = await acquirePlayAssetSources(host, ["scene-a"], { consumer: "Warmed", signal: new AbortController().signal });
    expect(compile).toHaveBeenCalledTimes(1);
    warmed.release();
    loading.trim({ force: true });
    expect(bundles).toEqual([]);
    expect(loading.snapshot().decodedBytes).toBe(0);
    const cold = await acquirePlayAssetSources(host, ["scene-a"], { consumer: "Cold again", signal: new AbortController().signal });
    expect(compile).toHaveBeenCalledTimes(2);
    cold.release(); loading.dispose();
  });

  it("starts genuine subsystem leaves and the selected Game Instance using only class headers", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    for (const [name, guid, parent] of [
      ["Session", "session", "GameInstance"], ["SystemBase", "base", "GameSubsystem"],
      ["System", "system", "SystemBase"], ["Weather", "weather", "SceneSubsystem"],
      ["Debug", "debug", "BDebugCommand"], ["UnusedPrefab", "unused", "Actor"],
    ]) await storage.writeBinary(`assets/${name}.class.babasset`, await encodeBabasset({
      header: { guid: guid!, name: name!, type: "Class", parentClass: parent, engineVersion: "0.0.0", version: 1, mode: "thin",
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1, payload: {} },
      chunks: [{ id: "document", kind: "document", mime: "application/json", data: new Uint8Array(4000) }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const before = storage.getReadMetrics();
    const project = createEmptyProject("Systems");
    project.settings.gameInstanceClass = "Session";
    expect(requiredProjectAssets(registry, project).sort()).toEqual(["session", "system", "weather"]);
    expect(storage.getReadMetrics()).toEqual(before);
  });

  it("cancels stalled catalog preparation before acquiring an ownership scope", async () => {
    const registry = new AssetRegistry(new MemoryStorageAdapter());
    vi.spyOn(registry, "getAssetLocator").mockImplementation(() => new Promise(() => undefined));
    const createScope = vi.fn(() => { throw new Error("Catalog preparation should precede ownership"); });
    const controller = new AbortController();
    const loading = acquirePlayAssetSources({
      registry, project: createEmptyProject("Play"), createScope,
      compile: async () => ({ bundles: [], diagnostics: [] }),
    }, ["scene"], { consumer: "Scene", signal: controller.signal });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(createScope).not.toHaveBeenCalled();
  });

  it("prepares only a cold command's requested font representation, including the project default", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    await storage.writeBinary("assets/font.babasset", await encodeBabasset({
      header: {
        guid: "font", name: "Font", type: "Font", version: 1, engineVersion: "0.0.0", mode: "thin",
        payload: { family: "Test", representations: { facetype: true, source: true } },
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1,
      }, chunks: [
        { id: FONT_FACETYPE_CHUNK_ID, kind: "font", mime: "application/json", data: new Uint8Array([123, 125]) },
        { id: "source", kind: "font", mime: "font/ttf", data: new Uint8Array(1000) },
      ],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loading = createRegistryAssetLoadingService(registry, { projectId: "play" });
    const project = createEmptyProject("Play");
    project.settings.fonts.defaultFontGuid = "font";
    const host = { registry, project, createScope: (owner: string) => loading.createScope(owner), compile: async () => ({ bundles: [], diagnostics: [] }) };
    const before = storage.getReadMetrics().actualBytesRead;
    const first = await acquirePlayAssetSources(host, ["font"], {
      consumer: "3D label", signal: new AbortController().signal, fontModes: new Map([["font", new Set(["facetype" as const])]]),
    });
    expect(first.game.fontFacetypeBytes.has("font")).toBe(true);
    expect(first.game.fontBytes.size).toBe(0);
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(2);
    const second = await acquirePlayAssetSources(host, [], {
      consumer: "Default bitmap label", signal: new AbortController().signal, fontModes: new Map([["", new Set(["bitmap" as const])]]),
    });
    expect(second.game.fontBytes.has("font")).toBe(true);
    expect(second.game.fontFacetypeBytes.size).toBe(0);
    expect(second.content).not.toBe(first.content);
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(1002);
    first.release(); second.release(); loading.dispose();
  });

  it("refreshes bounded catalog dependencies before preparing a scene changed outside the registry", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const writeScene = async (required: string[]) => storage.writeBinary("assets/scene.babasset", await encodeBabasset({
      header: {
        guid: "scene", name: "Scene", type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin", payload: { actors: [] },
        dependencies: required, requiredDependencies: required, dependencyMetadataVersion: 1,
      }, chunks: [],
    }));
    const model = buildBoxGlbFixture();
    await writeScene(["retired-dependency"]);
    await storage.writeBinary("assets/model.babasset", await encodeBabasset({
      header: {
        guid: "model", name: "Model", type: "Model", version: 1, engineVersion: "0.0.0", mode: "thin", payload: {},
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1,
      }, chunks: [{ id: "source", kind: "model", mime: "model/gltf-binary", data: model }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await writeScene(["model"]); // Watcher notification has not arrived yet.
    const loading = createRegistryAssetLoadingService(registry, { projectId: "play" });
    const prepared = await acquirePlayAssetSources({
      registry, project: createEmptyProject("Play"), createScope: owner => loading.createScope(owner),
      compile: async () => ({ bundles: [], diagnostics: [] }),
    }, ["scene"], { consumer: "Scene", signal: new AbortController().signal });
    expect(prepared.required).toEqual(new Set(["scene", "model"]));
    expect(prepared.game.modelBytes.get("model")).toEqual(model);
    expect(registry.accountedPayloadBytes).toBe(model.byteLength);
    expect(storage.getReadMetrics().fullReads).toBe(0);
    prepared.release();
    loading.dispose();
  });

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

import { describe, expect, it, vi } from "vitest";
import { createDocumentRef, createEmptyProject, documentId } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createInProcessRuntime } from "@babylonslate/runtime";
import type { CommandMessage, ScriptBundleEntry } from "@babylonslate/bridge";
import {
  AssetRegistry, buildBoxGlbFixture, createRegistryAssetLoadingService, encodeBabasset,
  FONT_FACETYPE_CHUNK_ID, projectContentRoot, type ChunkInput,
} from "@babylonslate/assets";
import { acquirePlayAssetSources, emptyPlaySourceControls, mergePreparedPlaySources, playDocumentOverrides, requiredProjectAssets } from "./play-asset-sources";
import type { OpenDocument } from "./document-service";

async function sceneSaveDuringCompilationFixture() {
  const storage = new MemoryStorageAdapter();
  await storage.pickProjectFolder();
  await storage.mkdir("assets");
  const writeScene = async (name: string, reverb: number) => storage.writeBinary("assets/scene.babasset", await encodeBabasset({
    header: {
      guid: "scene", name, type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin", payload: { name, actors: [] },
      dependencies: ["script"], requiredDependencies: ["script"], dependencyMetadataVersion: 1,
    }, chunks: [{ id: "audioReverb", kind: "audio-reverb", mime: "application/octet-stream", data: new Uint8Array([reverb]) }],
  }));
  await writeScene("Original", 1);
  await storage.writeBinary("assets/script.babasset", await encodeBabasset({
    header: {
      guid: "script", name: "Script", type: "Class", version: 1, engineVersion: "0.0.0", mode: "thin", payload: { nodes: [], edges: [] },
      dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1,
    }, chunks: [],
  }));
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  const loading = createRegistryAssetLoadingService(registry, { projectId: "background-save" });
  const scopes: Array<ReturnType<typeof loading.createScope>> = [];
  const host = {
    registry, project: createEmptyProject("Background Save"),
    createScope: (owner: string) => {
      const scope = loading.createScope(owner);
      vi.spyOn(scope, "dispose");
      scopes.push(scope);
      return scope;
    },
    compile: vi.fn(async () => ({ bundles: [], diagnostics: [] })),
  };
  return { storage, registry, loading, scopes, host, writeScene };
}

describe("Play source ownership", () => {
  it("uses fixed unsaved scene dependencies without writing or reusing another working document's packed content", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const scenePath = "assets/scene.babasset";
    const scenePayload = (name: string, font: string) => ({ name, actors: [{
      id: "label", name: "Label", classId: "Actor", components: [
        { id: "text", classId: "Text3DComponent", properties: { fontAssetGuid: font } },
        { id: "mesh", classId: "MeshComponent", properties: { meshKind: "box", materialGuid: "material" } },
      ],
    }] });
    const savedBytes = await encodeBabasset({ header: {
      guid: "scene", name: "Scene", type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin",
      payload: scenePayload("Saved", "saved-font"), dependencies: ["saved-font"], requiredDependencies: ["saved-font"], dependencyMetadataVersion: 1,
    }, chunks: [] });
    await storage.writeBinary(scenePath, savedBytes);
    await storage.writeBinary("assets/material.babasset", await encodeBabasset({ header: {
      guid: "material", name: "Material", type: "Material", version: 1, engineVersion: "0.0.0", mode: "thin",
      payload: { name: "Saved material", nodes: [], edges: [] }, dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1,
    }, chunks: [] }));
    for (const guid of ["saved-font", "live-font", "unrelated-font"]) await storage.writeBinary(`assets/${guid}.babasset`, await encodeBabasset({
      header: { guid, name: guid, type: "Font", version: 1, engineVersion: "0.0.0", mode: "thin", payload: { family: guid },
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1 },
      chunks: [{ id: FONT_FACETYPE_CHUNK_ID, kind: "font", mime: "application/json", data: new Uint8Array([123, 125]) }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loading = createRegistryAssetLoadingService(registry, { projectId: "working-scene" });
    const ref = createDocumentRef("scene", scenePath);
    const document: OpenDocument = { id: documentId(ref), ref, content: scenePayload("First draft", "live-font"), dirty: true, layout: null };
    const materialRef = createDocumentRef("material", "assets/material.babasset");
    const material: OpenDocument = { id: documentId(materialRef), ref: materialRef, content: { name: "First material", nodes: [], edges: [] }, dirty: true, layout: null };
    const firstOverrides = playDocumentOverrides(registry, [document, material]);
    const compile = vi.fn(async () => ({ bundles: [], diagnostics: [] }));
    const host = { registry, project: createEmptyProject("Working scene"), createScope: (owner: string) => loading.createScope(owner), compile,
      documentOverrides: firstOverrides };
    const options = { consumer: "Working Scene", signal: new AbortController().signal };
    const first = await acquirePlayAssetSources(host, ["scene"], options);
    expect(first.required).toEqual(new Set(["scene", "live-font", "material"]));
    expect(first.game.scenes.get("scene")?.name).toBe("First draft");
    expect(first.content.materialDocuments.get("material")?.name).toBe("First material");
    expect(first.game.fontFacetypeBytes.size).toBe(1);
    expect(loading.snapshot().entries.some(entry => ["saved-font", "unrelated-font"].includes(entry.assetId))).toBe(false);
    const nextOverrides = playDocumentOverrides(registry, [
      { ...document, content: scenePayload("Second draft", "live-font") },
      { ...material, content: { name: "Second material", nodes: [], edges: [] } },
    ]);
    const second = await acquirePlayAssetSources({ ...host, documentOverrides: nextOverrides }, ["scene"], options);
    const demand = await acquirePlayAssetSources(host, ["scene"], options);
    expect(second.game.scenes.get("scene")?.name).toBe("Second draft");
    expect(second.content.materialDocuments.get("material")?.name).toBe("Second material");
    expect(demand.game.scenes.get("scene")?.name).toBe("First draft");
    expect(demand.content.materialDocuments.get("material")?.name).toBe("First material");
    expect(demand.game.fontFamilies).toEqual(first.game.fontFamilies);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(await storage.readBinary(scenePath)).toEqual(savedBytes);
    first.release(); second.release(); demand.release();
    loading.trim({ force: true });
    expect(loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    loading.dispose();
  });

  it("retries a scene snapshot when a background reverb save completes during compilation", async () => {
    const fixture = await sceneSaveDuringCompilationFixture();
    fixture.host.compile.mockImplementationOnce(async () => {
      await fixture.writeScene("Fresh scene", 2);
      return { bundles: [], diagnostics: [] };
    });
    const prepared = await acquirePlayAssetSources(fixture.host, ["scene"], { consumer: "Play Scene", signal: new AbortController().signal });
    expect(fixture.host.compile).toHaveBeenCalledTimes(2);
    expect(fixture.scopes).toHaveLength(2);
    expect(fixture.scopes[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(prepared.game.scenes.get("scene")?.name).toBe("Fresh scene");
    expect(prepared.game.audioReverbBytes.get("scene")).toEqual(new Uint8Array([2]));
    fixture.loading.trim({ force: true });
    const current = await fixture.registry.getAssetLocator("scene");
    expect(fixture.loading.snapshot().entries.filter(entry => entry.assetId === "scene").every(entry => entry.revision === current.revision)).toBe(true);
    prepared.release();
    fixture.loading.trim({ force: true });
    expect(fixture.loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    fixture.loading.dispose();
  });

  it.each(["continuous save", "cancelled save", "decode failure"] as const)("bounds retries for %s and releases every failed scope", async (mode) => {
    const fixture = await sceneSaveDuringCompilationFixture();
    const controller = new AbortController();
    let writes = 0;
    fixture.host.compile.mockImplementation(async () => {
      if (mode === "decode failure") throw new SyntaxError("Invalid graph encoding");
      await fixture.writeScene(`Saved ${++writes}`, writes + 1);
      if (mode === "cancelled save") controller.abort();
      return { bundles: [], diagnostics: [] };
    });
    const request = acquirePlayAssetSources(fixture.host, ["scene"], { consumer: "Play Scene", signal: controller.signal });
    await expect(request).rejects.toThrow(mode === "continuous save" ? "could not stabilize after 3 attempts"
      : mode === "decode failure" ? "Invalid graph encoding" : /abort/i);
    expect(fixture.host.compile).toHaveBeenCalledTimes(mode === "continuous save" ? 3 : 1);
    expect(fixture.scopes.every(scope => vi.mocked(scope.dispose).mock.calls.length === 1)).toBe(true);
    await vi.waitFor(() => expect(fixture.loading.snapshot().temporaryBytes).toBe(0));
    fixture.loading.trim({ force: true });
    expect(fixture.loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    fixture.loading.dispose();
  });

  it("reloads console Classes by catalog GUID after path-labelled compiled sources are released", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const path = "assets/LoadLeft.class.babasset";
    const guid = "command-owner-guid";
    const command = { name: "stream_left_load", description: "Load left", category: "game", parameters: [] };
    await storage.writeBinary(path, await encodeBabasset({
      header: { guid, name: "LoadLeft.class", type: "Class", parentClass: "BDebugCommand", version: 1, engineVersion: "0.0.0", mode: "thin",
        payload: { nodes: [], edges: [] }, dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1, consoleCommand: command },
      chunks: [],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loading = createRegistryAssetLoadingService(registry, { projectId: "console-reload" });
    const compilerOutput: ScriptBundleEntry = {
      assetGuid: path, classId: "LoadLeft", parentClassId: "BDebugCommand", command,
      source: 'export async function onCommandRun(ctx) { await Promise.resolve(); ctx.reportCommand(true, "loaded"); }',
      entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: true }],
      anchors: [{ assetGuid: path, line: 1, column: 1, graphId: "graph", nodeId: "run" }],
    };
    const compile = vi.fn(async () => ({ bundles: [compilerOutput], diagnostics: [] }));
    const host = { registry, project: createEmptyProject("Commands"), createScope: (owner: string) => loading.createScope(owner), compile };
    const messages: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      classAssetGuids: { LoadLeft: guid }, consoleCommands: [{ ...command, classId: "LoadLeft", assetGuid: guid }],
      onCommand: message => messages.push(message),
    });
    try {
      for (let invocation = 0; invocation < 2; invocation++) {
        const completed = runtime.executeConsoleCommandAsync("stream_left_load");
        const request = messages.filter(message => message.type === "assetPreload").at(-1);
        if (!request || request.type !== "assetPreload") throw new Error("Expected a cold console acquisition");
        expect(request.assetGuids).toEqual([guid]);
        const prepared = await acquirePlayAssetSources(host, request.assetGuids, { consumer: request.ownerId, signal: new AbortController().signal });
        try {
          expect(prepared.game.scripts[0]).toMatchObject({ assetGuid: guid, source: compilerOutput.source, anchors: compilerOutput.anchors });
          expect(compilerOutput.assetGuid).toBe(path);
          await runtime.replaceScriptSources(prepared.game.scripts);
          runtime.setAssetLoadStates([{ guid, state: "ready" }]);
          runtime.notifyAssetPreloadResult({ preloadId: request.preloadId, success: true });
          expect(await completed).toEqual({ success: true, output: "loaded" });
          expect(messages.at(-1)).toEqual({ type: "assetPreloadRelease", preloadId: request.preloadId });
        } finally { prepared.release(); }
        await runtime.replaceScriptSources([]);
        runtime.setAssetLoadStates([{ guid, state: "unloaded" }]);
        loading.trim({ force: true });
      }
      expect(compile).toHaveBeenCalledTimes(2);
    } finally { runtime.stop(); loading.dispose(); }
  });

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
    const third = await acquirePlayAssetSources(host, ["font"], {
      consumer: "Second bitmap label", signal: new AbortController().signal, fontModes: new Map([["font", new Set(["bitmap" as const])]]),
    });
    const bitmap = second.sources.fonts?.[0]?.bytes;
    expect(ArrayBuffer.isView(bitmap)).toBe(true);
    if (!bitmap || !ArrayBuffer.isView(bitmap)) throw new Error("Expected a scoped font source view");
    expect(bitmap.buffer).toBe(second.game.fontBytes.get("font")?.buffer);
    expect(third.game.fontBytes.get("font")?.buffer).toBe(bitmap.buffer);
    first.release(); second.release();
    loading.trim({ force: true });
    expect(second.sources.fonts).toEqual([]);
    expect(second.game.fontBytes.size).toBe(0);
    expect(third.sources.fonts?.[0]?.bytes.byteLength).toBe(1000);
    expect(third.game.fontBytes.get("font")?.byteLength).toBe(1000);
    third.release();
    loading.trim({ force: true });
    expect(third.sources.fonts).toEqual([]);
    expect(loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    loading.dispose();
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
      { id: "navmesh", kind: "navmesh", mime: "application/octet-stream", data: new Uint8Array([1, 2, 3]) },
      { id: "audioReverb", kind: "audio-reverb", mime: "application/octet-stream", data: new Uint8Array([4, 5]) },
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
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(document.byteLength + model.byteLength + 12);
    expect(first.audioChunks.get("audio")?.get("second")).toEqual(new Uint8Array([3, 4, 5]));
    expect(first.game.fontBytes.size).toBe(0);
    expect(first.game.fontFacetypeBytes.has("font")).toBe(true);
    expect(first.content.complexMeshes.get("model")?.vertices.length).toBeGreaterThan(0);
    const second = await acquirePlayAssetSources(host, ["scene-b"], { consumer: "Scene B", signal: new AbortController().signal });
    expect(second.content.complexMeshes.get("model")).toBe(first.content.complexMeshes.get("model"));
    expect(storage.getReadMetrics().actualBytesRead - before).toBe(document.byteLength * 2 + model.byteLength + 17);
    const merged = mergePreparedPlaySources([first, second])!;
    expect(merged.game.scenes.size).toBe(2);
    expect(merged.content.complexMeshes.get("model")).toBe(second.content.complexMeshes.get("model"));
    expect(merged.controls.some((control) => control.type === "loadModels")).toBe(true);
    first.release();
    loading.trim({ force: true });
    expect(first.content.complexMeshes.size).toBe(0);
    expect(first.content.navmeshByScene.size).toBe(0);
    expect(first.content.audioReverbByScene.size).toBe(0);
    expect(first.content.navmeshBytes).toBeNull();
    expect(first.content.audioReverbBytes).toBeNull();
    expect(first.sources.audioLibrary?.audio.size).toBe(0);
    expect(second.content.complexMeshes.get("model")?.vertices.length).toBeGreaterThan(0);
    expect(second.content.navmeshBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.content.audioReverbBytes).toEqual(new Uint8Array([4, 5]));
    expect(second.sources.audioLibrary?.audio.has("audio")).toBe(true);
    second.release();
    loading.trim({ force: true });
    expect(second.content.complexMeshes.size).toBe(0);
    expect(second.content.navmeshByScene.size).toBe(0);
    expect(second.content.audioReverbByScene.size).toBe(0);
    expect(loading.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    expect(emptyPlaySourceControls()).toContainEqual({ type: "loadModels", models: [], complexMeshes: [] });
    loading.dispose();
  });
});

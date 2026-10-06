import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeBabasset } from "./babasset";
import { collectAssetDependencyMetadata } from "./asset-dependencies";
import { projectContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";
import { createRegistryAssetLoadingService, registryAssetRepresentation, type RegistryLoadedAsset } from "./registry-asset-loading";

describe("registry source loading", () => {
  it("resolves authored custom class names through catalog metadata while leaving deferred classes unread", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const header = (guid: string, type: string, payload: Record<string, unknown>) => ({
      guid, name: guid, type, version: 1, engineVersion: "0.0.0", mode: "thin" as const, payload,
      ...collectAssetDependencyMetadata(type, payload),
    });
    await storage.writeBinary("assets/scene.babasset", await encodeBabasset({
      header: header("scene", "Scene", { actors: [{ id: "enemy", classId: "Goblin", components: [{ classId: "CameraComponent" }] }] }), chunks: [],
    }));
    const classDocument = new TextEncoder().encode(JSON.stringify({ nodes: [], edges: [], members: [] }));
    await storage.writeBinary("assets/Goblin.class.babasset", await encodeBabasset({
      header: { ...header("custom-class", "Class", {}), parentClass: "Actor", dependencies: ["model"], requiredDependencies: ["model"], dependencyMetadataVersion: 1 },
      chunks: [{ id: "document", kind: "document", mime: "application/json", data: classDocument }],
    }));
    await storage.writeBinary("assets/model.babasset", await encodeBabasset({
      header: header("model", "Model", {}), chunks: [{ id: "source", kind: "model", mime: "application/octet-stream", data: new Uint8Array([1, 2, 3]) }],
    }));
    await storage.writeBinary("assets/Later.class.babasset", await encodeBabasset({
      header: header("later-class", "Class", {}),
      chunks: [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode(JSON.stringify({ note: "x".repeat(100_000) })) }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    expect(registry.requiredDependenciesFor("scene")).toEqual(["custom-class"]);
    expect(registry.showReferences("custom-class").inbound).toEqual(["scene"]);
    const loader = createRegistryAssetLoadingService(registry, {
      projectId: "classes", selectChunks: asset => asset.header.type === "Model" ? ["source"] : [],
    });
    const scope = loader.createScope("Scene");
    await scope.acquire("scene");
    expect(registry.accountedPayloadBytes).toBe(classDocument.byteLength + 3);
    expect(loader.getLoadState("custom-class")).toBe("ready");
    expect(loader.getLoadState("later-class")).toBe("unloaded");
    expect(storage.getReadMetrics().fullReads).toBe(0);
    loader.dispose();
  });

  it("reports a missing required custom class instead of publishing an incomplete scene", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const payload = { actors: [{ id: "enemy", classId: "MissingEnemy", components: [] }] };
    await storage.writeBinary("assets/scene.babasset", await encodeBabasset({
      header: { guid: "scene", name: "scene", type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin",
        payload, ...collectAssetDependencyMetadata("Scene", payload) }, chunks: [],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loader = createRegistryAssetLoadingService(registry, { projectId: "classes" });
    const scope = loader.createScope("Scene");
    await expect(scope.acquire("scene")).rejects.toThrow("missing Class MissingEnemy");
    expect(registry.accountedPayloadBytes).toBe(0);
    loader.dispose();
  });

  it("validates a warm catalog against saves before returning cached source data", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const write = async (name: string) => storage.writeBinary("assets/document.babasset", await encodeBabasset({
      header: {
        guid: "document", name, type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1, payload: { name, actors: [] },
      }, chunks: [],
    }));
    await write("Original");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loader = createRegistryAssetLoadingService(registry, { projectId: "project" });
    const scope = loader.createScope("editor");
    const first = await scope.acquire<RegistryLoadedAsset>("document");
    await write("Replaced");
    // No watcher/reindex call: even a header-only warm asset checks storage.
    const second = await scope.acquire<RegistryLoadedAsset>("document");
    expect(first.document.payload.name).toBe("Original");
    expect(second.document.payload.name).toBe("Replaced");
    expect(first.revision).not.toBe(second.revision);
    loader.dispose();
  });

  it("shares selected source bytes between instances without reading a deferred asset or unused variant", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const selected = new Uint8Array([1, 2, 3]);
    await storage.writeBinary("assets/model.babasset", await encodeBabasset({
      header: {
        guid: "model", name: "Model", type: "Model", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: ["later"], requiredDependencies: [], dependencyMetadataVersion: 1, payload: { sourceChunkId: "compact" },
      },
      chunks: [
        { id: "compact", kind: "model", mime: "application/octet-stream", data: selected },
        { id: "original", kind: "model", mime: "application/octet-stream", data: new Uint8Array(512 * 1024) },
      ],
    }));
    await storage.writeBinary("assets/later.babasset", await encodeBabasset({
      header: {
        guid: "later", name: "Later", type: "Model", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1, payload: {},
      },
      chunks: [{ id: "source", kind: "model", mime: "application/octet-stream", data: new Uint8Array(512 * 1024) }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const catalogBytes = storage.getReadMetrics().actualBytesRead;
    expect(catalogBytes).toBeLessThan(16 * 1024);
    const loader = createRegistryAssetLoadingService(registry, { projectId: "project" });
    const representation = await registryAssetRepresentation(registry, "model", { selectChunks: () => ["compact"] });
    const first = loader.createScope("scene one");
    const second = loader.createScope("scene two");
    const [a, b] = await Promise.all([
      first.acquire("model", representation), second.acquire("model", representation),
    ]);
    expect(a.chunks.get("compact")).toEqual(selected);
    expect(a).toBe(b);
    expect(a.chunks.has("original")).toBe(false);
    expect(storage.getReadMetrics().actualBytesRead - catalogBytes).toBe(3);
    first.dispose();
    loader.trim({ force: true });
    expect(b.chunks.get("compact")).toEqual(selected);
    second.dispose();
    loader.trim({ force: true });
    expect(b.chunks.size).toBe(0);
    expect(loader.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    loader.dispose();
  });

  it("allows editing legacy documents without preparing dependencies, but requires an explicit runtime metadata upgrade", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    await storage.writeBinary("assets/scene.babasset", await encodeBabasset({
      header: {
        guid: "scene", name: "Scene", type: "Scene", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: ["missing-model"], payload: {},
      },
      chunks: [{ id: "document", kind: "document", mime: "application/json", data: new TextEncoder().encode('{"name":"Draft","actors":[]}') }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loader = createRegistryAssetLoadingService(registry, { projectId: "project" });
    const editor = loader.createScope("editor");
    const loaded = await editor.acquire<RegistryLoadedAsset>("scene", undefined, { dependencies: "none" });
    expect(loaded.document.payload).toEqual({ name: "Draft", actors: [] });
    await expect(loader.createScope("runtime").acquire("scene")).rejects.toMatchObject({ code: "dependency-metadata-upgrade-required" });
    loader.dispose();
  });
});

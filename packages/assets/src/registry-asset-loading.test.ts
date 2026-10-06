import { describe, expect, it, vi } from "vitest";
import { createMountedProjectStorage, createReadOnlyProjectStorage, HttpCatalogStorageAdapter, MemoryStorageAdapter, type HttpStorageCatalog } from "@babylonslate/vfs";
import { MAIN_CLASS_FILE, MAIN_SCENE_FILE } from "@babylonslate/core";
import { BABASSET_PREFIX_BYTES, encodeBabasset, readBabassetHeaderLength } from "./babasset";
import { sha256Hex } from "./bytes";
import { collectAssetDependencyMetadata } from "./asset-dependencies";
import { projectContentRoot } from "./content-root";
import { AssetRegistry } from "./registry";
import { createRegistryAssetLoadingService, registryAssetRepresentation, type RegistryLoadedAsset } from "./registry-asset-loading";
import { installMinimalProject } from "./test-support/minimal-project";

describe("registry source loading", () => {
  it.each([
    ["inline", "fetch"], ["inline", "body"], ["blob", "fetch"], ["blob", "body"],
  ] as const)("cancels a stalled %s HTTP %s only after its final owner leaves, releases reservations, and retries", async (location, stage) => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const objects = new Map<string, Uint8Array>([["source", source]]);
    const catalog: HttpStorageCatalog = { version: 1, files: [] };
    const bytes = await encodeBabasset({
      header: { guid: "model", name: "Model", type: "Model", version: 1, engineVersion: "0.0.0", mode: "thin",
        dependencies: [], requiredDependencies: [], dependencyMetadataVersion: 1, payload: {} },
      chunks: [{ id: "source", kind: "model", mime: "application/octet-stream", data: source }],
      ...(location === "blob" ? { blobThreshold: 1, writeBlob: async (hash: string, data: Uint8Array) => {
        catalog.files.push({ path: `assets/.blobs/${hash}`, size: data.byteLength, revision: hash,
          parts: [{ offset: 0, length: data.byteLength, file: "source", sha256: hash }] });
      } } : {}),
    });
    const headerLength = readBabassetHeaderLength(bytes);
    const payloadOffset = BABASSET_PREFIX_BYTES + headerLength;
    objects.set("prefix", bytes.slice(0, BABASSET_PREFIX_BYTES));
    objects.set("header", bytes.slice(BABASSET_PREFIX_BYTES, payloadOffset));
    const segments: Array<readonly [string, number, number]> = [
      ["prefix", 0, BABASSET_PREFIX_BYTES], ["header", BABASSET_PREFIX_BYTES, headerLength],
      ...(location === "inline" ? [["source", payloadOffset, source.byteLength] as const] : []),
    ];
    const parts = await Promise.all(segments.map(async ([file, offset, length]) => ({ file, offset, length,
      sha256: await sha256Hex(objects.get(file)!) })));
    catalog.files.push({ path: "assets/model.babasset", size: bytes.byteLength, revision: "model-revision", parts });
    let stall = true;
    let transportSignal: AbortSignal | undefined;
    let started!: () => void;
    const pendingRead = new Promise<void>(resolve => { started = resolve; });
    const cancelBody = vi.fn();
    const fetchContent = vi.fn<typeof fetch>(async (input, init) => {
      const file = String(input).split("/").at(-1)!;
      if (file !== "source" || !stall) return new Response(new Uint8Array(objects.get(file)!));
      transportSignal = init?.signal ?? undefined;
      if (stage === "fetch") {
        started();
        return new Promise<Response>((_resolve, reject) => {
          transportSignal?.addEventListener("abort", () => reject(transportSignal!.reason), { once: true });
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(source.slice(0, 2)); },
        // With no prefetch, this means the adapter consumed the first two bytes
        // and is awaiting another body read, which will never arrive.
        pull() { started(); },
        cancel: cancelBody,
      }, { highWaterMark: 0 }));
    });
    const transport = new HttpCatalogStorageAdapter(catalog, { baseUrl: "/", fetch: fetchContent });
    const mounted = createMountedProjectStorage([{ path: "", sourcePath: "", storage: transport }]);
    const storage = createReadOnlyProjectStorage(mounted);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const beforeBytes = transport.getReadMetrics().actualBytesRead;
    const loader = createRegistryAssetLoadingService(registry, {
      projectId: "http-cancellation", selectChunks: () => ["source"], budgets: { concurrency: 1 },
    });
    const first = loader.createScope("first scene");
    const second = loader.createScope("second scene");
    try {
      const firstResult = first.acquire("model").catch((error: unknown) => error);
      await pendingRead;
      const secondResult = second.acquire("model").catch((error: unknown) => error);
      await vi.waitFor(() => expect(loader.snapshot().entries[0]?.owners).toHaveLength(2));
      const sharedSignal = transportSignal!;
      expect(sharedSignal).toBeDefined();
      first.dispose();
      expect(await firstResult).toMatchObject({ code: "cancelled" });
      expect(sharedSignal.aborted).toBe(false);
      expect(loader.snapshot()).toMatchObject({ active: 1 });
      second.dispose();
      expect(await secondResult).toMatchObject({ code: "cancelled" });
      expect(sharedSignal.aborted).toBe(true);
      await vi.waitFor(() => expect(loader.snapshot()).toMatchObject({
        active: 0, queued: 0, reservedSourceBytes: 0, reservedDecodedBytes: 0, temporaryBytes: 0, entries: [],
      }));
      expect(registry.payloadLoader.snapshot()).toMatchObject({ pending: 0, failed: 1 });
      if (stage === "body") expect(cancelBody).toHaveBeenCalledOnce();
      const discarded = stage === "body" ? 2 : 0;
      expect(transport.getReadMetrics().actualBytesRead - beforeBytes).toBe(discarded);
      expect(mounted.getReadMetrics!().actualBytesRead).toBe(transport.getReadMetrics().actualBytesRead);

      stall = false;
      const retry = await loader.createScope("retry scene").acquire<RegistryLoadedAsset>("model");
      expect(retry.chunks.get("source")).toEqual(source);
      expect(fetchContent.mock.calls.filter(([url]) => String(url).endsWith("/source"))).toHaveLength(2);
      expect(transport.getReadMetrics().actualBytesRead - beforeBytes).toBe(discarded + source.byteLength);
    } finally { loader.dispose(); }
  });

  it("prepares the shared authored fixture's startup scene and its actual Class", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await installMinimalProject(storage);
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const scene = registry.getByPath(MAIN_SCENE_FILE)!;
    const main = registry.getByPath(MAIN_CLASS_FILE)!;
    const loader = createRegistryAssetLoadingService(registry, { projectId: "minimal-project" });
    try {
      await loader.createScope("startup scene").acquire(scene.header.guid);
      expect(loader.getLoadState(scene.header.guid)).toBe("ready");
      expect(loader.getLoadState(main.header.guid)).toBe("ready");
    } finally {
      loader.dispose();
    }
  });

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

  it("prepares native behaviour-tree nodes and required authored tasks from the catalog", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    const payload = { nodes: [
      { id: "root", classId: "bt.composite.selector", children: ["sequence"] },
      { id: "sequence", classId: "bt.composite.sequence", children: ["succeed", "hunt"] },
      { id: "succeed", classId: "bt.task.succeed" },
      { id: "hunt", classId: "Hunt", decorators: [{ classId: "bt.decorator.cooldown" }],
        services: [{ classId: "bt.service.setBlackboard" }] },
    ] };
    await storage.writeBinary("assets/patrol.babasset", await encodeBabasset({
      header: { guid: "patrol", name: "Patrol", type: "BehaviourTree", version: 1, engineVersion: "0.0.0", mode: "thin",
        payload, ...collectAssetDependencyMetadata("BehaviourTree", payload) }, chunks: [],
    }));
    const classDocument = new TextEncoder().encode(JSON.stringify({ nodes: [], edges: [], members: [] }));
    await storage.writeBinary("assets/Hunt.class.babasset", await encodeBabasset({
      header: { guid: "hunt", name: "Hunt", type: "Class", version: 1, engineVersion: "0.0.0", mode: "thin",
        parentClass: "BTTask", payload: {}, ...collectAssetDependencyMetadata("Class", {}, { parentClass: "BTTask" }) },
      chunks: [{ id: "document", kind: "document", mime: "application/json", data: classDocument }],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loader = createRegistryAssetLoadingService(registry, { projectId: "behaviour-tree" });
    try {
      await loader.createScope("Patrol").acquire("patrol");
      expect(loader.getLoadState("patrol")).toBe("ready");
      expect(loader.getLoadState("hunt")).toBe("ready");
      expect(registry.showReferences("hunt").inbound).toEqual(["patrol"]);
      expect(registry.accountedPayloadBytes).toBe(classDocument.byteLength);
    } finally {
      loader.dispose();
    }
  });

  it.each([
    { type: "Scene", classId: "MissingEnemy", payload: { actors: [{ id: "enemy", classId: "MissingEnemy", components: [] }] } },
    { type: "BehaviourTree", classId: "MissingTask", payload: { nodes: [{ id: "task", classId: "MissingTask" }] } },
    { type: "BehaviourTree", classId: "bt.task.custom", payload: { nodes: [{ id: "task", classId: "bt.task.custom" }] } },
  ])("reports missing required $classId instead of publishing an incomplete $type", async ({ type, classId, payload }) => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder();
    await storage.mkdir("assets");
    await storage.writeBinary("assets/scene.babasset", await encodeBabasset({
      header: { guid: "scene", name: "scene", type, version: 1, engineVersion: "0.0.0", mode: "thin",
        payload, ...collectAssetDependencyMetadata(type, payload) }, chunks: [],
    }));
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const loader = createRegistryAssetLoadingService(registry, { projectId: "classes" });
    const scope = loader.createScope("Scene");
    await expect(scope.acquire("scene")).rejects.toThrow(`missing Class ${classId}`);
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

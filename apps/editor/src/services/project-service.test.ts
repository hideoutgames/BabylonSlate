import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryOpfsRoot } from "../../../../packages/vfs/src/test-support/memory-opfs";
import { createEmptyProject, PROJECT_FILE, SourceRevisionChangedError, type ProjectStorage } from "@babylonslate/core";
import { MemoryStorageAdapter, OpfsStorageAdapter } from "@babylonslate/vfs";
import { encodeAssetDocument, encodeBabasset } from "@babylonslate/assets";
import { loadKenneyMannequinGlb } from "../lib/kenney-mannequin";
import { ProjectService } from "./project-service";
import { setEncodeQueuePauseReason } from "./encode-queue-pause";
import { DocumentService } from "./document-service";

beforeEach(() => {
  const root = createMemoryOpfsRoot();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
});
afterEach(() => vi.unstubAllGlobals());

vi.mock("../lib/kenney-mannequin", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../lib/kenney-mannequin")>();
  return { ...mod, loadKenneyMannequinGlb: vi.fn(mod.loadKenneyMannequinGlb) };
});

function workerFactory() {
  const workers: Array<{
    encode: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const create = vi.fn(() => {
    const encode = vi.fn(async () => ({ ktx2: new Uint8Array(), wallMs: 0 }));
    const dispose = vi.fn();
    const worker = Object.assign(encode, {
      dispose,
      recycleCount: () => 0,
    });
    workers.push({ encode, dispose });
    return worker;
  });
  return { create, workers };
}

describe("ProjectService lifecycle", () => {
  it.each(["chunk", "document"] as const)("retries a complete %s read after a concurrent save without retaining the failed snapshot", async (kind) => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("ConcurrentRead");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const path = "assets/Racing.scene.babasset";
    const bytes = (name: string) => encodeAssetDocument({ type: "Scene", name, guid: "racing", version: 4, payload: { name, actors: [] } });
    await storage.writeBinary(path, await bytes("Before"));
    await service.registry!.reindexPath(path);
    const after = await bytes("After saving");
    const read = storage.readBinaryRange.bind(storage);
    let saved = false;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (assetPath, offset, length, revision) => {
      if (assetPath === path && revision !== undefined && !saved) {
        saved = true;
        await storage.writeBinary(path, after);
      }
      return read(assetPath, offset, length, revision);
    });
    const value = kind === "chunk"
      ? JSON.parse(new TextDecoder().decode((await service.readAssetChunk(path, "document"))!))
      : await service.loadDocument("scene", path);
    expect(saved).toBe(true);
    expect(value).toMatchObject({ name: "After saving", actors: [] });
    service.assetLoadingService.trim({ force: true });
    expect(service.assetLoadingService.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    service.dispose();
  });

  it.each(["chunk", "document"] as const)("reserves the current revision before a growing %s payload is read", async (kind) => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("GrowingRead");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const path = "assets/Growing.scene.babasset";
    const before = { name: "Before", actors: [] };
    const after = { name: "After saving", actors: [], notes: "x".repeat(8192) };
    const bytes = (payload: Record<string, unknown>) => encodeAssetDocument({ type: "Scene", name: "Growing", guid: "growing", version: 4, payload });
    await storage.writeBinary(path, await bytes(before));
    const registry = service.registry!;
    await registry.reindexPath(path);
    const replacement = await bytes(after);
    const estimate = registry.getChunkByteLength.bind(registry);
    let saved = false;
    vi.spyOn(registry, "getChunkByteLength").mockImplementation(async (...args) => {
      const length = await estimate(...args);
      if (args[0] === "growing" && !saved) {
        saved = true;
        await storage.writeBinary(path, replacement);
      }
      return length;
    });
    const reservations: Array<{ bytes: number; reserved: number }> = [];
    const read = storage.readBinaryRange.bind(storage);
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (assetPath, offset, length, revision) => {
      if (assetPath === path && offset > 12 && length > 0) {
        reservations.push({ bytes: length, reserved: service.assetLoadingService.snapshot().reservedSourceBytes });
      }
      return read(assetPath, offset, length, revision);
    });
    const value = kind === "chunk"
      ? JSON.parse(new TextDecoder().decode((await service.readAssetChunk(path, "document"))!))
      : await service.loadDocument("scene", path);
    expect(value).toMatchObject({ name: after.name, actors: [] });
    expect(saved).toBe(true);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].reserved).toBeGreaterThanOrEqual(reservations[0].bytes);
    service.assetLoadingService.trim({ force: true });
    expect(service.assetLoadingService.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0, entries: [] });
    service.dispose();
  });

  it.each(["changing", "cancelled", "corrupt", "project changed"] as const)("bounds ordinary source-read retries for %s failures", async (mode) => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("FailedRead");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const path = "assets/Racing.scene.babasset";
    await storage.writeBinary(path, await encodeAssetDocument({ type: "Scene", name: "Racing", guid: "racing", version: 4, payload: { actors: [] } }));
    await service.registry!.reindexPath(path);
    const read = storage.readBinaryRange.bind(storage);
    const controller = new AbortController();
    let attempted = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (assetPath, offset, length, revision) => {
      if (assetPath === path && revision !== undefined) {
        attempted++;
        if (mode === "cancelled") controller.abort();
        if (mode === "project changed") service.dispose();
        if (mode === "corrupt") throw new Error("Corrupt chunk data");
        throw new SourceRevisionChangedError("Concurrent save");
      }
      return read(assetPath, offset, length, revision);
    });
    await expect(service.readAssetChunk(path, "document", { signal: controller.signal })).rejects.toThrow(
      mode === "changing" ? "3 read attempts" : mode === "corrupt" ? "Corrupt chunk data" : /abort|project changed/i,
    );
    expect(attempted).toBe(mode === "changing" ? 3 : 1);
    service.dispose();
  });

  it.each(["catalog", "payload"] as const)("aborts a chunk read's pending %s transport when its consumer cancels", async (phase) => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("CancelledTransport");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const path = "assets/Pending.scene.babasset";
    await storage.writeBinary(path, await encodeAssetDocument({ type: "Scene", name: "Pending", guid: "pending", version: 4, payload: { actors: [] } }));
    await service.registry!.reindexPath(path);
    const port: ProjectStorage = storage;
    const read = port.readBinaryRange.bind(port);
    let transportSignal: AbortSignal | undefined;
    vi.spyOn(port, "readBinaryRange").mockImplementation(async (...args) => {
      const [assetPath, offset, , , options] = args;
      if (assetPath === path && (phase === "catalog" ? offset === 0 : offset > 12)) {
        transportSignal = options?.signal;
        if (!transportSignal) throw new Error("Pending transport has no cancellation signal");
        const signal = transportSignal;
        signal.throwIfAborted();
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return read(...args);
    });
    const controller = new AbortController();
    const reading = service.readAssetChunk(path, "document", { signal: controller.signal });
    const rejected = expect(reading).rejects.toThrow(/abort|cancel/i);
    await vi.waitFor(() => expect(transportSignal).toBeDefined());
    controller.abort();
    await rejected;
    expect(transportSignal!.aborted).toBe(true);
    await vi.waitFor(() => expect(service.assetLoadingService.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, temporaryBytes: 0 }));
    service.dispose();
  });

  it("opens an idle project without reading inline Scene bodies or unrelated source chunks", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("IdleCatalog");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    await storage.writeBinary("assets/unused.scene.babasset", await encodeAssetDocument({
      type: "Scene", name: "Unused", guid: "unused-scene", version: 4,
      payload: { name: "Unused", actors: [], notes: "x".repeat(256 * 1024) },
    }, { extraChunks: [{ id: "unused-source", kind: "source", mime: "application/octet-stream", data: new Uint8Array(1024 * 1024) }] }));
    const before = storage.getReadMetrics().actualBytesRead;
    const fullReads = vi.spyOn(storage, "readBinary");
    await service.loadCurrentProject();
    expect(service.registry!.getByGuid("unused-scene")?.header.name).toBe("Unused");
    expect(fullReads.mock.calls.filter(([path]) => path.endsWith(".babasset") || path.includes(".blobs/"))).toEqual([]);
    expect(storage.getReadMetrics().actualBytesRead - before).toBeLessThan(64 * 1024);
    expect(service.assetLoadingService.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    service.dispose();
  });

  it("shares source ownership with open asset editors and frees cached sources when their final tab closes", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("ScopedEditors");
    const project = new ProjectService(storage);
    await project.loadCurrentProject();
    const action = project.registry!.list().find((asset) => asset.header.type === "InputAction")!;
    const documents = new DocumentService();
    const id = await documents.openDocument(project, { kind: "input-action", path: action.path, label: action.header.name });
    const working = documents.getDocument(id)!;
    const changed = { ...(working.content as Record<string, unknown>), name: "Unsaved Name" };
    documents.updateAssetDocument(id, changed);
    expect(project.assetLoadingService.snapshot().entries.some((entry) => entry.owners.includes(`Asset Editor: ${id}`))).toBe(true);
    const other = project.createAssetLoadScope("Preview");
    const persisted = await project.loadDocument("input-action", action.path, { scope: other });
    expect(persisted).not.toMatchObject({ name: "Unsaved Name" });
    documents.closeDocument(id);
    project.assetLoadingService.trim({ force: true });
    expect(project.assetLoadingService.snapshot().entries.some((entry) => entry.owners.includes("Preview"))).toBe(true);
    other.dispose();
    project.assetLoadingService.trim({ force: true });
    expect(project.assetLoadingService.snapshot()).toMatchObject({ sourceBytes: 0, decodedBytes: 0, entries: [] });
    expect(working.content).toMatchObject({ name: "Unsaved Name" });
    project.dispose();
  });

  it("initializes and disposes provider resources idempotently", () => {
    const factory = workerFactory();
    const service = new ProjectService(new MemoryStorageAdapter("documents"), {
      createWorkerEncode: factory.create,
    });

    expect(factory.create).not.toHaveBeenCalled();
    service.initialize();
    service.initialize();
    expect(factory.create).toHaveBeenCalledTimes(1);

    service.dispose();
    service.dispose();
    expect(factory.workers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps provider resources alive when a project closes", async () => {
    const factory = workerFactory();
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage, {
      createWorkerEncode: factory.create,
    });
    service.initialize();
    await storage.openDocumentsProject("CloseLifecycle");

    await service.closeProject();

    expect(factory.workers[0]?.dispose).not.toHaveBeenCalled();
    service.dispose();
    expect(factory.workers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the registry generation rising across a remount, a close and a reopen", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Generation");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    const opened = service.registryGeneration;

    // A remount scans the same files into a new registry.
    await service.remountRegistry();
    const remounted = service.registryGeneration;
    expect(remounted).toBeGreaterThan(opened);

    await service.closeProject();
    const closed = service.registryGeneration;
    expect(closed).toBeGreaterThan(remounted);

    await storage.openDocumentsProject("Generation");
    await service.loadCurrentProject();
    expect(service.registryGeneration).toBeGreaterThan(closed);
  });

  it("supports a Strict Mode-style initialize/dispose/remount sequence", () => {
    const factory = workerFactory();
    const service = new ProjectService(new MemoryStorageAdapter("documents"), {
      createWorkerEncode: factory.create,
    });
    const pause = vi.spyOn(service.textureEncodeQueue, "pause");

    service.initialize();
    service.dispose();
    setEncodeQueuePauseReason("strict-mode-test", true);
    expect(pause).not.toHaveBeenCalled();

    service.initialize();
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1);
    service.dispose();
    expect(
      factory.workers.map(({ dispose }) => dispose.mock.calls.length),
    ).toEqual([1, 1]);
    setEncodeQueuePauseReason("strict-mode-test", false);
  });
});

describe("project round-trip", () => {
  it("H13: saves and reloads replacement and explicitly empty asset bindings", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("InputRoundTrip");
    const service = new ProjectService(storage);
    const { document, layouts } = await service.loadCurrentProject();
    const asset = service.registry!.list().find((entry) => entry.header.type === "InputAction" && entry.header.name === "Jump")!;
    expect(asset).toBeDefined();
    const payload = await service.loadDocument("input-action", asset.path);
    for (const bindings of [
      [{ id: "primary", device: "key", code: "KeyF" }, { id: "alternate", device: "key", code: "KeyH" }],
      [],
    ]) {
      await service.saveDocument("input-action", asset.path, { ...payload, bindings });
      await service.saveProject(document, layouts);
      const reloaded = new ProjectService(storage);
      await reloaded.loadCurrentProject();
      const restored = await reloaded.loadDocument("input-action", asset.path);
      expect(restored).toMatchObject({ bindings });
    }
  });
  it("creates and saves a new project", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    await storage.openDocumentsProject("RoundTrip.babproject");

    const { document, layouts } = await service.loadCurrentProject();
    expect(document.metadata.name).toBeTruthy();
    expect(layouts.tabOrder).toEqual([]);

    await service.saveProject(document, layouts);

    const exists = await storage.exists(PROJECT_FILE);
    expect(exists).toBe(true);
  });

  it("creates a project folder without a .babproject suffix", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    await service.createEmptyProject("MyGame");
    expect(storage.getCurrentFolder()?.name).toBe("MyGame");
  });

  it("refuses to create over an existing project folder", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    await service.createEmptyProject("Taken");
    await expect(service.createEmptyProject("Taken")).rejects.toThrow(
      "Name already exists.",
    );
  });

  it("refuses template creation over an existing chosen project and preserves its audio", async () => {
    const storage = new MemoryStorageAdapter("external");
    await storage.pickProjectFolder();
    await storage.writeText(PROJECT_FILE, '{"guid":"original"}');
    await storage.writeBinary("assets/song.wav", new Uint8Array([1, 2, 3]));
    const service = new ProjectService(storage);
    await expect(service.createFromTemplate({
      name: "Replacement",
      pickFolder: true,
      templateFiles: [{ path: PROJECT_FILE, data: new TextEncoder().encode('{"guid":"template"}') }],
    })).rejects.toThrow(/already exists/i);
    expect(await storage.readText(PROJECT_FILE)).toBe('{"guid":"original"}');
    expect(await storage.readBinary("assets/song.wav")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("does not scaffold a new project when reconnect selects an empty folder", async () => {
    const storage = new MemoryStorageAdapter("external");
    const service = new ProjectService(Object.assign(storage, {
      reconnectFolder: () => storage.pickProjectFolder(),
    }));
    await expect(service.reconnect()).rejects.toThrow(/project/i);
    expect(await storage.readdir("")).toEqual([]);
  });

  it("rejects an array manifest during reconnect", async () => {
    const storage = new MemoryStorageAdapter("external");
    await storage.pickProjectFolder();
    await storage.writeText(PROJECT_FILE, "[]");
    const service = new ProjectService(Object.assign(storage, {
      reconnectFolder: async () => storage.getCurrentFolder()!,
    }));
    await expect(service.reconnect()).rejects.toThrow("Invalid project manifest");
    expect(await storage.readText(PROJECT_FILE)).toBe("[]");
  });

  it("rewrites metadata.name without renaming the folder", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    const handle = await storage.openDocumentsProject("RenameMe.babproject");
    await service.loadCurrentProject();
    await service.closeProject();

    await service.renameListedProjectDisplayName(handle, "Pretty Name");
    const reopened = await service.openListedProject(handle);
    expect(reopened.document.metadata.name).toBe("Pretty Name");
    expect(storage.getCurrentFolder()?.name).toBe("RenameMe.babproject");
  });

  it("persists the selected project badge through creation and reopening", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    const created = await service.createEmptyProject("Badge Game", {
      kind: "2d",
      appearance: { icon: "rocket", color: "lilac", image: "data:image/png;base64,AAAA" },
    });
    expect(created.document.metadata.appearance).toEqual({
      icon: "rocket", color: "lilac", image: "data:image/png;base64,AAAA",
    });
    const handle = storage.getCurrentFolder()!;
    await service.closeProject();
    const reopened = await service.openListedProject(handle);
    expect(reopened.document.metadata.appearance).toEqual({
      icon: "rocket", color: "lilac", image: "data:image/png;base64,AAAA",
    });
  });

  it("edits project identity without changing the folder or its assets", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    await service.createEmptyProject("Original", { kind: "2d" });
    await storage.writeBinary("assets/keep.bin", new Uint8Array([3, 1, 4]));
    const handle = storage.getCurrentFolder()!;
    await service.closeProject();

    await service.updateListedProject(handle, {
      name: "  New Name  ",
      appearance: { icon: "mountain", color: "coral" },
    });

    expect(storage.getCurrentFolder()).toBeNull();
    const reopened = await service.openListedProject(handle);
    expect(reopened.document.metadata.name).toBe("New Name");
    expect(reopened.document.metadata.appearance).toEqual({ icon: "mountain", color: "coral" });
    expect(storage.getCurrentFolder()?.name).toBe("Original");
    expect(await storage.readBinary("assets/keep.bin")).toEqual(new Uint8Array([3, 1, 4]));
    await service.closeProject();
    await service.renameListedProjectDisplayName(handle, "Renamed Again");
    expect((await service.openListedProject(handle)).document.metadata.appearance)
      .toEqual({ icon: "mountain", color: "coral" });
  });

  it("uses the selected badge for a template while preserving template settings and assets", async () => {
    const source = new ProjectService(new MemoryStorageAdapter("documents"));
    await source.createEmptyProject("Template", { kind: "2d" });
    const files = await source.readTree();
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);

    const created = await service.createFromTemplate({
      name: "From Template",
      templateFiles: files,
      appearance: { icon: "gamepad", color: "mint" },
    });

    expect(created.document.metadata.name).toBe("From Template");
    expect(created.document.metadata.appearance).toEqual({ icon: "gamepad", color: "mint" });
    expect(created.document.settings.twoD).toEqual(
      (await source.loadCurrentProject()).document.settings.twoD,
    );
    const asset = files.find((file) => file.path.endsWith(".babasset"))!;
    expect(await storage.readBinary(asset.path)).toEqual(asset.data);
  });

  it("keeps legacy template metadata complete when a badge is selected", async () => {
    const legacy = createEmptyProject("Legacy");
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    const created = await service.createFromTemplate({
      name: "New Project",
      appearance: { icon: "box", color: "mint" },
      templateFiles: [{
        path: PROJECT_FILE,
        data: new TextEncoder().encode(JSON.stringify({
          name: "Legacy", guid: "old", kind: "project", version: 1,
          settings: legacy.settings, scenes: [], graphs: [],
        })),
      }],
    });
    expect(created.document.metadata.name).toBe("New Project");
    expect(created.document.metadata.createdAt).toBeTruthy();
    expect(created.document.metadata.appearance).toEqual({ icon: "box", color: "mint" });
  });

  it("removes the registered folder when project scaffolding fails", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    vi.mocked(loadKenneyMannequinGlb).mockRejectedValueOnce(
      new Error("Invalid bundled Mannequin GLB"),
    );
    await expect(service.createEmptyProject("Broken")).rejects.toThrow(
      "Invalid bundled Mannequin GLB",
    );
    expect(await service.listProjects()).toEqual([]);
    expect(storage.getCurrentFolder()).toBeNull();
    await service.createEmptyProject("Broken");
    expect(storage.getCurrentFolder()?.name).toBe("Broken");
  });

  it("keeps a pre-existing folder that lacks project.json when scaffolding fails", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    await storage.openDocumentsProject("Kept");
    await storage.writeText("notes.txt", "x");
    await storage.releaseFolder();
    vi.mocked(loadKenneyMannequinGlb).mockRejectedValueOnce(
      new Error("Invalid bundled Mannequin GLB"),
    );
    await expect(service.createEmptyProject("Kept")).rejects.toThrow();
    expect((await storage.listProjects()).map((p) => p.name)).toContain("Kept");
    await storage.openDocumentsProject("Kept");
    expect(await storage.exists("notes.txt")).toBe(true);
  });

  it("does not delete another operation's folder when the current folder changed mid-scaffold", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    let reject!: (e: Error) => void;
    vi.mocked(loadKenneyMannequinGlb).mockImplementationOnce(
      () => new Promise((_, r) => { reject = r; }),
    );
    const pending = service.createEmptyProject("First");
    await vi.waitFor(() => expect(reject).toBeDefined());
    await storage.openDocumentsProject("Second");
    await storage.writeText("keep.txt", "y");
    reject(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
    const names = (await storage.listProjects()).map((p) => p.name);
    expect(names).toContain("Second");
    // Cleanup is skipped rather than silently deleting the orphan it created.
    expect(names).toContain("First");
    expect(storage.getCurrentFolder()?.name).toBe("Second");
    expect(await storage.exists("keep.txt")).toBe(true);
  });

  it("surfaces the original error when cleanup itself fails", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    vi.mocked(loadKenneyMannequinGlb).mockRejectedValueOnce(
      new Error("Invalid bundled Mannequin GLB"),
    );
    vi.spyOn(storage, "deleteProject").mockRejectedValueOnce(
      new Error("cleanup failed"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(service.createEmptyProject("Warned")).rejects.toThrow(
        "Invalid bundled Mannequin GLB",
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("Warned");
    } finally {
      warn.mockRestore();
      vi.mocked(storage.deleteProject).mockRestore();
    }
  });

  it("leaves a user-picked folder in place when scaffolding fails", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    vi.mocked(loadKenneyMannequinGlb).mockRejectedValueOnce(
      new Error("Invalid bundled Mannequin GLB"),
    );
    await expect(
      service.createEmptyProject("Picked", { pickFolder: true }),
    ).rejects.toThrow("Invalid bundled Mannequin GLB");
    expect((await storage.listProjects()).length).toBe(1);
  });

  it("removes the registered folder when template scaffolding fails", async () => {
    localStorage.clear();
    const storage = new OpfsStorageAdapter();
    const service = new ProjectService(storage);
    await expect(
      service.createFromTemplate({
        name: "Tmpl",
        templateFiles: [
          { path: PROJECT_FILE, data: new TextEncoder().encode("not json") },
        ],
      }),
    ).rejects.toThrow();
    expect(await storage.listProjects()).toEqual([]);
  });

  it("deleteListedProject removes OPFS files so the same name is empty", async () => {
    localStorage.clear();
    const storage = new MemoryStorageAdapter("opfs");
    const service = new ProjectService(storage);
    await service.createEmptyProject("Gone");
    const handle = storage.getCurrentFolder()!;
    expect(await storage.exists("project.json")).toBe(true);
    await service.deleteListedProject(handle);
    expect(await storage.listProjects()).toEqual([]);
    await storage.openKnownFolder(handle);
    expect(await storage.exists("project.json")).toBe(false);
  });
});

describe("texture encode diagnostics", () => {
  it("records an Output Log line with asset name, guid, and exact error", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("EncodeDiag");
    await storage.mkdir("assets", true);
    const bytes = await encodeBabasset({
      header: {
        guid: "tex-guid-1",
        type: "Texture",
        name: "Albedo",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "encode_failed", usage: "albedo" },
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "image/png",
          data: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    await storage.writeBinary("assets/albedo.babasset", bytes);

    const service = new ProjectService(storage, {
      encode: async () => {
        throw new Error("BasisEncoder.encode returned 0");
      },
    });
    // 2D Empty has no Kenney albedo Texture, so this test does not race scaffold encodes.
    await service.createEmptyProject("EncodeDiag", { kind: "2d" });
    const lines: string[] = [];
    service.onDiagnostic((line) => lines.push(line));

    service.textureEncodeQueue.enqueue({
      assetGuid: "tex-guid-1",
      source: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      settings: {
        format: "uastc",
        quality: 2,
        maxDimension: 2048,
        generateMipmaps: true,
      },
    });

    await vi.waitFor(() => {
      expect(lines.some((line) => line.includes("tex-guid-1"))).toBe(true);
    });
    expect(lines[0]).toBe(
      "Texture encode failed for Albedo (tex-guid-1): BasisEncoder.encode returned 0",
    );
    expect(service.sessionDiagnostics).toEqual(lines);
  });
});

import { describe, expect, it, vi } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import { WebStorageAdapter } from "@babylonslate/vfs";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeBabasset } from "@babylonslate/assets";
import { ProjectService } from "./project-service";
import { setEncodeQueuePauseReason } from "./encode-queue-pause";

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
  it("creates and saves a new project", async () => {
    localStorage.clear();
    const storage = new WebStorageAdapter();
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
    const storage = new WebStorageAdapter();
    const service = new ProjectService(storage);
    await service.createEmptyProject("MyGame");
    expect(storage.getCurrentFolder()?.name).toBe("MyGame");
  });

  it("refuses to create over an existing project folder", async () => {
    localStorage.clear();
    const storage = new WebStorageAdapter();
    const service = new ProjectService(storage);
    await service.createEmptyProject("Taken");
    await expect(service.createEmptyProject("Taken")).rejects.toThrow(
      "Name already exists.",
    );
  });

  it("rewrites metadata.name without renaming the folder", async () => {
    localStorage.clear();
    const storage = new WebStorageAdapter();
    const service = new ProjectService(storage);
    const handle = await storage.openDocumentsProject("RenameMe.babproject");
    await service.loadCurrentProject();
    await service.closeProject();

    await service.renameListedProjectDisplayName(handle, "Pretty Name");
    const reopened = await service.openListedProject(handle);
    expect(reopened.document.metadata.name).toBe("Pretty Name");
    expect(storage.getCurrentFolder()?.name).toBe("RenameMe.babproject");
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

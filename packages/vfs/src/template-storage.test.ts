import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryOpfsRoot } from "./test-support/memory-opfs";
import { webcrypto } from "node:crypto";
import type { ProjectFolderHandle } from "@babylonslate/core";

const isMobile = vi.fn(() => false);
const isElectron = vi.fn(() => false);

vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  isMobilePlatform: () => isMobile(),
  isElectronHost: () => isElectron(),
  getHostPlatform: () => (isMobile() ? "ios" : isElectron() ? "electron" : "web"),
}));

// Capacitor Filesystem needs a device; the Documents tier is covered by its own
// fake-FS unit tests, so here we only assert which adapter gets picked.
class FakeDocumentsAdapter {
  folder: ProjectFolderHandle | null = null;
  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    this.folder = { id: `documents:${name}`, name, tier: "documents" };
    return this.folder;
  }
  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder;
  }
}

vi.mock("./documents-adapter", () => ({
  DocumentsStorageAdapter: FakeDocumentsAdapter,
}));

const { createTemplateStorage } = await import("./template-storage");
const { OpfsStorageAdapter } = await import("./web-adapter");
const { ElectronLibraryStorageAdapter } = await import("./electron-storage-adapter");

describe("createTemplateStorage", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
    isElectron.mockReturnValue(false);
    localStorage.clear();
    const root = createMemoryOpfsRoot();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("binds OPFS at the templates folder on web", async () => {
    const storage = await createTemplateStorage("__slate_templates__");
    expect(storage).toBeInstanceOf(OpfsStorageAdapter);
    expect(storage.getCurrentFolder()?.name).toBe("__slate_templates__");
  });

  it("keeps the library out of the OPFS project list and the restored project", async () => {
    const projects = new OpfsStorageAdapter();
    const project = await projects.openDocumentsProject("Game");
    await createTemplateStorage("__slate_templates__");
    const reopened = new OpfsStorageAdapter();
    expect(await reopened.listProjects()).toEqual([project]);
    expect(reopened.getCurrentFolder()).toEqual(project);
  });

  it("binds the scoped userData library on Electron instead of OPFS", async () => {
    isElectron.mockReturnValue(true);
    const writes: unknown[][] = [];
    const project = { writeBinary: vi.fn() };
    vi.stubGlobal("babylonslate", {
      project,
      library: { writeBinary: async (...args: unknown[]) => { writes.push(args); } },
    });
    const storage = await createTemplateStorage("__slate_engine_plugins__");
    expect(storage).toBeInstanceOf(ElectronLibraryStorageAdapter);
    await storage.writeText("catalog.json", "{}");
    expect(writes).toEqual([["__slate_engine_plugins__", "catalog.json", expect.any(ArrayBuffer)]]);
    expect(project.writeBinary).not.toHaveBeenCalled();
  });

  it("binds the Documents tier at the templates folder on mobile", async () => {
    isMobile.mockReturnValue(true);
    const storage = await createTemplateStorage("__slate_templates__");
    expect(storage).toBeInstanceOf(FakeDocumentsAdapter);
    expect(storage.getCurrentFolder()).toEqual({
      id: "documents:__slate_templates__",
      name: "__slate_templates__",
      tier: "documents",
    });
  });
});

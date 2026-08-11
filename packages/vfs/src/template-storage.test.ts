import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@babylonslate/core";

const isMobile = vi.fn(() => false);

vi.mock("./platform", () => ({
  isMobilePlatform: () => isMobile(),
  getHostPlatform: () => (isMobile() ? "ios" : "web"),
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

describe("createTemplateStorage", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
    localStorage.clear();
  });

  it("binds OPFS at the templates folder on web", async () => {
    const storage = await createTemplateStorage("Templates");
    expect(storage).toBeInstanceOf(OpfsStorageAdapter);
    expect(storage.getCurrentFolder()?.name).toBe("Templates");
  });

  it("binds the Documents tier at the templates folder on mobile", async () => {
    isMobile.mockReturnValue(true);
    const storage = await createTemplateStorage("Templates");
    expect(storage).toBeInstanceOf(FakeDocumentsAdapter);
    expect(storage.getCurrentFolder()).toEqual({
      id: "documents:Templates",
      name: "Templates",
      tier: "documents",
    });
  });
});

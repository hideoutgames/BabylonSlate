import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import { WebStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

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
});

import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "@babylonslate/shared";
import { WebStorageAdapter } from "@babylonslate/storage";
import { ProjectService } from "./project-service";

describe("project round-trip", () => {
  it("creates and saves a new project", async () => {
    localStorage.clear();
    const storage = new WebStorageAdapter();
    const service = new ProjectService(storage);
    await storage.pickProjectFolder();

    const { document, layouts } = await service.loadCurrentProject();
    expect(document.metadata.name).toBeTruthy();
    expect(layouts.tabOrder).toEqual([]);

    await service.saveProject(document, layouts);

    const exists = await storage.exists(PROJECT_FILE);
    expect(exists).toBe(true);
  });
});

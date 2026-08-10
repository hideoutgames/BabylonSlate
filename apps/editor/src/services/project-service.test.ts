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

    const state = await service.loadCurrentProject();
    expect(state.document.metadata.name).toBeTruthy();
    expect(state.graph.nodes.length).toBeGreaterThan(0);

    await service.saveProject(state);

    const exists = await storage.exists(PROJECT_FILE);
    expect(exists).toBe(true);
  });
});

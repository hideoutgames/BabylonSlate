import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { ProjectService } from "./project-service";

describe("input asset project conversion", () => {
  it("copies legacy mappings once, preserves their display names, and never recreates deleted inputs", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Inputs.babproject");
    await installMinimalProject(storage);
    const raw = JSON.parse(await storage.readText(PROJECT_FILE));
    raw.settings.input = {
      actions: [
        { name: "Jump High", bindings: [{ device: "key", code: "Space" }] },
      ],
      axes: [],
    };
    delete raw.settings.inputAssetsVersion;
    await storage.writeText(PROJECT_FILE, JSON.stringify(raw));
    const service = new ProjectService(storage);
    const loaded = await service.loadCurrentProject();
    expect(loaded.document.settings).toMatchObject({
      inputAssetsVersion: 1,
      input: { actions: [], axes: [] },
    });
    const assets = service
      .registry!.list()
      .filter((asset) => asset.header.type === "InputAction");
    expect(assets).toHaveLength(1);
    expect(assets[0]!.header.name).toBe("Jump High");
    const payload = await service.loadDocument("input-action", assets[0]!.path);
    expect(payload).toMatchObject({
      legacyName: "Jump High",
      bindings: [{ code: "Space", id: "binding-1" }],
    });
    await service.saveDocument("input-action", assets[0]!.path, payload!);
    expect(
      service
        .registry!.list()
        .find((asset) => asset.header.guid === assets[0]!.header.guid)?.header
        .name,
    ).toBe("Jump High");
    await storage.remove(assets[0]!.path);
    await new ProjectService(storage).loadCurrentProject();
    expect(await storage.exists(assets[0]!.path)).toBe(false);
  });
});

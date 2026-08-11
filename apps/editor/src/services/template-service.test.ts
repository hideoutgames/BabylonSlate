import { describe, expect, it, vi } from "vitest";
import {
  createEmptyProjectFiles,
  encodeAssetDocument,
  encodeProjectZip,
  writeProjectTree,
} from "@babylonslate/assets";
import {
  defaultEngineSettings,
  MemoryStorageAdapter,
  type EngineSettings,
} from "@babylonslate/vfs";
import { ProjectService } from "./project-service";
import { loadTemplateCards } from "./template-service";

async function folderWithTemplates() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Templates");
  const files = createEmptyProjectFiles({ guid: "tpl", name: "Platformer" });
  await writeProjectTree(
    storage,
    files.map((f) => ({ path: `Platformer.babproject/${f.path}`, data: f.data })),
  );
  await storage.writeBinary(
    "TopDown.babproject",
    encodeProjectZip(createEmptyProjectFiles({ guid: "tpl2", name: "TopDown" })),
  );
  return storage;
}

function settings(patch: Partial<EngineSettings> = {}): EngineSettings {
  return { ...defaultEngineSettings(), ...patch };
}

describe("Homepage template cards", () => {
  it("lists directory and zip templates from the settings folder", async () => {
    const storage = await folderWithTemplates();
    const openTemplatesFolder = vi.fn(async () => storage);

    const cards = await loadTemplateCards({
      platform: "ios",
      loadSettings: async () => settings({ templatesFolder: "Templates" }),
      openTemplatesFolder,
    });

    expect(cards.map((c) => c.name)).toEqual(["Platformer", "TopDown"]);
    expect(openTemplatesFolder).toHaveBeenCalledWith("Templates");
  });

  it("offers Empty only on web", async () => {
    const openTemplatesFolder = vi.fn();
    const cards = await loadTemplateCards({
      platform: "web",
      loadSettings: async () => settings({ templatesFolder: "Templates" }),
      openTemplatesFolder,
    });

    expect(cards).toEqual([]);
    expect(openTemplatesFolder).not.toHaveBeenCalled();
  });

  it("shows no cards until a templates folder is set", async () => {
    const cards = await loadTemplateCards({
      platform: "ios",
      loadSettings: async () => settings({ templatesFolder: null }),
      openTemplatesFolder: vi.fn(),
    });
    expect(cards).toEqual([]);
  });

  it("degrades to no cards when the templates folder cannot be opened", async () => {
    const cards = await loadTemplateCards({
      platform: "ios",
      loadSettings: async () => settings({ templatesFolder: "Gone" }),
      openTemplatesFolder: async () => {
        throw new Error("folder missing");
      },
    });
    expect(cards).toEqual([]);
  });

  it("creates a project from a template card with a new name and identity", async () => {
    const templates = await folderWithTemplates();
    const cards = await loadTemplateCards({
      platform: "ios",
      loadSettings: async () => settings({ templatesFolder: "Templates" }),
      openTemplatesFolder: async () => templates,
    });

    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles: cards[0]!.files,
      name: "MyPlatformer",
    });

    expect(document.metadata.name).toBe("MyPlatformer.babproject");
    const manifest = JSON.parse(await destination.readText("project.json"));
    expect(manifest.name).toBe("MyPlatformer.babproject");
    expect(manifest.guid).not.toBe("tpl");
    expect(destination.getCurrentFolder()?.name).toBe("MyPlatformer.babproject");

    // A template that ships no documents still opens with a usable scene.
    expect(document.scenes).toHaveLength(1);
    expect(await destination.exists(document.scenes[0]!)).toBe(true);
    expect(await service.loadDocument("scene", document.scenes[0]!)).toEqual(
      expect.objectContaining({ meshes: expect.any(Array) }),
    );
  });

  it("keeps the documents a template ships instead of scaffolding new ones", async () => {
    const templates = await folderWithTemplates();
    await templates.mkdir("Platformer.babproject/assets", true);
    const sceneBytes = await encodeAssetDocument({
      type: "Scene",
      name: "level1.scene",
      guid: "template-scene",
      version: 1,
      payload: { name: "Level 1", meshes: [] },
    });
    await templates.writeBinary(
      "Platformer.babproject/assets/level1.scene.babasset",
      sceneBytes,
    );

    const cards = await loadTemplateCards({
      platform: "ios",
      loadSettings: async () => settings({ templatesFolder: "Templates" }),
      openTemplatesFolder: async () => templates,
    });
    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles: cards.find((c) => c.name === "Platformer")!.files,
      name: "FromTemplate",
    });

    expect(document.scenes).toEqual(["assets/level1.scene.babasset"]);
    expect(
      await service.loadDocument("scene", "assets/level1.scene.babasset"),
    ).toEqual({ name: "Level 1", meshes: [] });
  });
});

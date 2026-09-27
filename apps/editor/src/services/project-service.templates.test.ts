import { describe, expect, it } from "vitest";
import {
  createEmptyProjectFiles,
  encodeAssetDocument,
  encodeProjectZip,
  listTemplates,
  writeProjectTree,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";

async function folderWithTemplates() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Templates");
  const files = createEmptyProjectFiles({ guid: "tpl", name: "Platformer" });
  await writeProjectTree(
    storage,
    files.map((f) => ({ path: `Platformer/${f.path}`, data: f.data })),
  );
  await storage.writeBinary(
    "TopDown.zip",
    encodeProjectZip(createEmptyProjectFiles({ guid: "tpl2", name: "TopDown" })),
  );
  return storage;
}

describe("Create Project from a template", () => {
  it("creates a project from a template card with a new name and identity", async () => {
    const cards = await listTemplates(await folderWithTemplates());

    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles: cards[0]!.files,
      name: "MyPlatformer",
    });

    expect(document.metadata.name).toBe("MyPlatformer");
    const manifest = JSON.parse(await destination.readText("project.json"));
    expect(manifest.name).toBe("MyPlatformer");
    expect(manifest.guid).not.toBe("tpl");
    expect(destination.getCurrentFolder()?.name).toBe("MyPlatformer");

    // A template that ships no documents still opens with a usable scene.
    expect(document.scenes).toHaveLength(1);
    expect(await destination.exists(document.scenes[0]!)).toBe(true);
    expect(await service.loadDocument("scene", document.scenes[0]!)).toEqual(
      expect.objectContaining({ actors: expect.any(Array) }),
    );
  });

  it("keeps the documents a template ships instead of scaffolding new ones", async () => {
    const templates = await folderWithTemplates();
    await templates.mkdir("Platformer/assets", true);
    const sceneBytes = await encodeAssetDocument({
      type: "Scene",
      name: "level1.scene",
      guid: "template-scene",
      version: 1,
      payload: { name: "Level 1", meshes: [] },
    });
    await templates.writeBinary(
      "Platformer/assets/level1.scene.babasset",
      sceneBytes,
    );

    const cards = await listTemplates(templates);
    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles: cards.find((c) => c.name === "Platformer")!.files,
      name: "FromTemplate",
    });

    expect(document.scenes).toEqual(["assets/level1.scene.babasset"]);
    expect(
      await service.loadDocument("scene", "assets/level1.scene.babasset"),
    ).toMatchObject({ name: "Level 1", actors: [], viewportMode: "3d" });
  });
});

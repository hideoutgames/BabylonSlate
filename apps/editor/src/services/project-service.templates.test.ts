import { describe, expect, it } from "vitest";
import {
  encodeAssetDocument,
  encodeProjectZip,
  loadTemplateFiles,
  writeProjectTree,
} from "@haptic/assets";
import { createEmptyProjectFiles } from "@haptic/assets/test-support/project-files";
import { SCENE_SCHEMA_VERSION } from "@haptic/core";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createStepProgress, templateStepCount } from "../lib/create-project";
import { takeProjectThumbnailRequest } from "../lib/model-thumbnail-queue";
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
    const templateFiles = await loadTemplateFiles(await folderWithTemplates(), "Platformer");

    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles,
      name: "MyPlatformer",
    });

    expect(document.metadata.name).toBe("MyPlatformer");
    // A template brings no thumbnails: the new project's first editor session generates them, once.
    expect(takeProjectThumbnailRequest(service.guid!)).toBe(true);
    expect(takeProjectThumbnailRequest(service.guid!)).toBe(false);
    const manifest = JSON.parse(await destination.readText("project.json"));
    expect(manifest.metadata.name).toBe("MyPlatformer");
    expect(manifest.guid).not.toBe("tpl");
    expect(destination.getCurrentFolder()?.name).toBe("MyPlatformer");

    // A template that ships no documents still opens with a usable scene.
    expect(document.scenes).toHaveLength(1);
    expect(await destination.exists(document.scenes[0]!)).toBe(true);
    expect(await service.loadDocument("scene", document.scenes[0]!)).toEqual(
      expect.objectContaining({ actors: expect.any(Array) }),
    );
  });

  it("counts every template file and each remaining step once, so the progress ends on the last step the caller adds", async () => {
    const templateFiles = await loadTemplateFiles(await folderWithTemplates(), "Platformer");
    const service = new ProjectService(new MemoryStorageAdapter("documents"));
    const percents: number[] = [];
    // The editor's own attach step and final step bracket the service's.
    const progress = createStepProgress(templateStepCount(templateFiles.length), (percent) => percents.push(percent));
    progress.advance();
    await service.createFromTemplate({ templateFiles, name: "Counted", progress });
    expect(percents.at(-1)).toBeLessThan(100);
    progress.advance();
    expect(percents.at(-1)).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(new Set(percents).size).toBe(percents.length);
  });

  it("keeps the documents a template ships instead of scaffolding new ones", async () => {
    const templates = await folderWithTemplates();
    await templates.mkdir("Platformer/assets", true);
    const sceneBytes = await encodeAssetDocument({
      type: "Scene",
      name: "level1.scene",
      guid: "template-scene",
      version: SCENE_SCHEMA_VERSION,
      payload: { name: "Level 1", meshes: [] },
    });
    await templates.writeBinary(
      "Platformer/assets/level1.scene.hasset",
      sceneBytes,
    );

    const templateFiles = await loadTemplateFiles(templates, "Platformer");
    const destination = new MemoryStorageAdapter("documents");
    const service = new ProjectService(destination);
    const { document } = await service.createFromTemplate({
      templateFiles,
      name: "FromTemplate",
    });

    expect(document.scenes).toEqual(["assets/level1.scene.hasset"]);
    expect(
      await service.loadDocument("scene", "assets/level1.scene.hasset"),
    ).toMatchObject({ name: "Level 1", actors: [], viewportMode: "3d" });
  });
});

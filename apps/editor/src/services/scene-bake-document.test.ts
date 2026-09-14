import { expect, it, vi } from "vitest";
import {
  createDefaultScene,
  documentId,
  type SerializedScene,
} from "@babylonslate/core";
import { AssetRegistry, projectContentRoot } from "@babylonslate/assets";
import { EditSession } from "@babylonslate/edit";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
import { captureSceneBakeDocument } from "./scene-bake-document";

async function setup() {
  const storage = new MemoryStorageAdapter();
  await storage.pickProjectFolder("Bake Owner");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  const ref = {
    kind: "scene" as const,
    path: "scene.babasset",
    label: "Scene",
  };
  const scene = createDefaultScene();
  scene.settings.bakedLightingAssetGuid = "prior";
  for (const [guid, type] of [
    ["scene", "Scene"],
    ["candidate", "BakedLighting"],
    ["material", "Material"],
  ])
    await registry.createAsset("project", `${guid}.babasset`, {
      guid,
      type,
      name: guid,
      version: 1,
      payload: {},
      chunks: [],
      dependencies: [],
    });
  const documents = new DocumentService();
  const project = {
    loadDocument: async () => scene,
  } as unknown as ProjectService;
  await documents.openDocument(project, ref);
  const edits = new EditSession();
  let identity = "project-1",
    writable = true;
  const options = {
    documents,
    edits,
    registry,
    documentId: documentId(ref),
    projectIdentity: () => identity,
    canWrite: () => writable,
    onApplied: vi.fn(),
  };
  const hash = "a".repeat(64);
  const expected = {
    sceneGuid: "scene",
    generation: 0,
    inputs: {
      geometry: hash,
      uv: hash,
      transforms: hash,
      materials: hash,
      lights: hash,
      environment: hash,
      settings: hash,
      provider: hash,
    },
  };
  return {
    options,
    scene,
    expected,
    documents,
    edits,
    registry,
    ref,
    project,
    changeProject: () => {
      identity = "project-2";
    },
    lock: () => {
      writable = false;
    },
  };
}

it("commits one exact current Scene reference through dirty state and Undo/Redo", async () => {
  const { options, expected, documents, edits } = await setup();
  const owner = captureSceneBakeDocument(options);
  expect(owner.commit("candidate", expected)).toBe(true);
  const current = documents.getDocument(options.documentId)!;
  expect(
    (current.content as SerializedScene).settings.bakedLightingAssetGuid,
  ).toBe("candidate");
  expect(current.dirty).toBe(true);
  const undo = edits.undo(
    options.documentId,
    current.content as SerializedScene,
  )!;
  documents.updateScene(options.documentId, undo.doc);
  expect(undo.doc.settings.bakedLightingAssetGuid).toBe("prior");
  const redo = edits.redo(options.documentId, undo.doc)!;
  expect(redo.doc.settings.bakedLightingAssetGuid).toBe("candidate");
  expect(options.onApplied).toHaveBeenCalledOnce();
  expect(owner.commit("candidate", expected)).toBe(false);
});

it("rejects intervening edits even when content returns to the original object, and rejects replacement owners", async () => {
  const fixture = await setup();
  const { options, expected, documents, scene } = fixture;
  const original = captureSceneBakeDocument(options);
  documents.updateScene(options.documentId, { ...scene, name: "Edited" });
  documents.updateScene(options.documentId, scene);
  expect(original.commit("candidate", expected)).toBe(false);
  const reloaded = captureSceneBakeDocument(options);
  documents.replaceLoadedContent(options.documentId, scene);
  expect(reloaded.isCurrent()).toBe(false);
  const next = captureSceneBakeDocument(options);
  fixture.changeProject();
  expect(next.isCurrent()).toBe(false);
  expect(scene.settings.bakedLightingAssetGuid).toBe("prior");
});

it("refuses changed material inputs or a newly locked document while immutable candidate additions remain safe", async () => {
  const fixture = await setup();
  const { options, expected, registry } = fixture;
  const owner = captureSceneBakeDocument(options);
  registry.getByGuid("material")!.header.payload = { changed: true };
  expect(owner.commit("candidate", expected)).toBe(false);
  const fresh = captureSceneBakeDocument(options);
  await registry.createAsset("project", "geometry.babasset", {
    guid: "geometry",
    type: "BakedGeometry",
    name: "Geometry",
    version: 1,
    payload: {},
    chunks: [],
    dependencies: [],
  });
  expect(fresh.isCurrent()).toBe(true);
  fixture.lock();
  expect(fresh.commit("candidate", expected)).toBe(false);
  expect(options.onApplied).not.toHaveBeenCalled();
});

import { installMinimalProject } from "../../../../packages/assets/src/test-support/minimal-project";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultScene,
  createActor,
  createMeshComponent,
  documentId,
  MAIN_CLASS_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  SCENE_SCHEMA_VERSION,
  type SerializedScene,
} from "@haptic/core";
import {
  decodeAssetDocument,
  decodeHasset,
  encodeAssetDocument,
  encodeHasset,
  normalizeAnimationPayload,
  normalizeSkeletonPayload,
  readAssetDocumentHeader,
  clearDeletedAssetRefs,
  createDefaultTilesetPayload,
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  sha256Hex,
  sniffImageSize,
  textureEncodeSize,
  writeTraceDocument,
  applyOwnAssetWrite,
  classifyExternalChanges,
  snapshotIndexedMtimes,
  readEnvironmentTextureInfo,
  type EncodeFn,
} from "@haptic/assets";
import { buildFloatDdsCubeFixture, buildRadianceHdrFixture } from "@haptic/test-kit/environment-fixtures";
import {
  AREA_EMISSION_CHUNK_KIND,
  AREA_EMISSION_EDGE,
  areaEmissionChunkId,
  AssetFormatVersionError,
  AUDIO_REVERB_CHUNK_ID,
  decodeAreaEmission,
  decodePackedAudioAsset,
  encodeAreaEmission,
} from "@haptic/assets";
import { NAVMESH_CHUNK_ID } from "@haptic/navigation";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ProjectService } from "./project-service";
import { DocumentService } from "./document-service";
import { createDefaultLogicGraphSerialized } from "./graph-validation";
import { MANNEQUIN_CLASS_FILE } from "../lib/scaffold-empty-3d";
import { createDefaultMaterialDocument } from "@haptic/shader-graph";
import { collectAudioReverbFlushScenes, createAudioReverbBakeController } from "../lib/audio-reverb-bake";
import { loadExportDocuments } from "./export-game-inputs";

const DEFAULT_3D_CLASS_FILE = `assets/${MANNEQUIN_CLASS_FILE}`;

/** KTX2 identifier plus pixelWidth / pixelHeight. */
function ktx2Header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  return bytes;
}

/** PNG signature + IHDR size (enough for size sniffing). */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Stand-in encoder: a KTX2 header at the size the real encoders produce. */
const standInEncode: EncodeFn = async (source, settings) => {
  const size = sniffImageSize(source)!;
  const encoded = textureEncodeSize(size.width, size.height, settings);
  return { ktx2: ktx2Header(encoded.width, encoded.height), wallMs: 0 };
};

/** The id a 1x1 source's encode commits under (maxDimension 1, uastc, quality 2, mips). */
const KTX2_KEY_MAX_1 = "ktx2:30d6ee4fb9bf2d2e";

/** A compressed 1x1 Texture whose encode predates alignment: committed 1x1, nothing recorded. */
async function writeLegacyOddTexture(storage: MemoryStorageAdapter, path: string, guid: string): Promise<void> {
  await storage.writeBinary(path, await encodeHasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
      payload: { usage: "albedo", compressionState: "compressed", ktx2ChunkId: KTX2_KEY_MAX_1, width: 1, height: 1 },
    },
    chunks: [
      { id: "pixels", kind: "pixels", mime: "image/png", data: pngHeader(1, 1) },
      { id: KTX2_KEY_MAX_1, kind: "ktx2", mime: "image/ktx2", data: ktx2Header(1, 1) },
    ],
  }));
}

/** Turns source control **Enable** on in project.json, as a shared checkout has it. */
async function enableSourceControlOnDisk(storage: MemoryStorageAdapter): Promise<void> {
  const project = JSON.parse(await storage.readText(PROJECT_FILE)) as { settings: Record<string, unknown> };
  project.settings.sourceControl = { ...(project.settings.sourceControl as object | undefined), enabled: true };
  await storage.writeText(PROJECT_FILE, JSON.stringify(project));
}

/** Let the storage clock move on, so the next write gets another mtime. */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

async function scaffolded(authentic = false) {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Assets.hproject");
  if (!authentic) await installMinimalProject(storage);
  const service = new ProjectService(storage);
  const loaded = await service.loadCurrentProject();
  return { storage, service, loaded };
}

describe("project documents as .hasset", () => {
  it.each(["rename", "move"])("restores saved Scene and Class tabs by GUID after a %s", async (operation) => {
    const { service, storage, loaded } = await scaffolded();
    const documents = new DocumentService();
    const sceneId = await documents.openDocument(service, { kind: "scene", path: MAIN_SCENE_FILE, label: "Main" }, { panel: "viewport" });
    const classId = await documents.openDocument(service, { kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }, { panel: "graph" });
    documents.setPanelPlacement(classId, "graph", { referencePanelId: "graph", direction: "right", width: 300 });
    await service.saveProject(loaded.document, documents.buildLayouts());
    const sceneGuid = service.guidForPath(MAIN_SCENE_FILE)!;
    const classGuid = service.guidForPath(MAIN_CLASS_FILE)!;
    const scene = operation === "rename"
      ? await service.registry!.renameAsset(sceneGuid, "Arena")
      : await service.registry!.moveAsset(sceneGuid, "project", "Levels/main.scene.hasset");
    const graph = operation === "rename"
      ? await service.renameAsset(classGuid, "Hero")
      : await service.registry!.moveAsset(classGuid, "project", "Classes/main.class.hasset");
    const fresh = new ProjectService(storage);
    const restored = await fresh.loadCurrentProject();
    const reopened = new DocumentService();
    await reopened.initializeFromProject(fresh, restored.document, restored.layouts);
    const newSceneId = documentId({ kind: "scene", path: scene.path });
    const newClassId = documentId({ kind: "graph", path: graph.path });
    expect(reopened.getDocument(newSceneId)?.layout).toEqual({ panel: "viewport" });
    expect(reopened.getDocument(newClassId)?.layout).toEqual({ panel: "graph" });
    expect(reopened.getPanelPlacements(newClassId).graph).toEqual({ referencePanelId: "graph", direction: "right", width: 300 });
    expect(reopened.getDocument(sceneId)).toBeUndefined();
    expect(reopened.getDocument(classId)).toBeUndefined();
  });

  it("opens a legacy project with stale saved tabs while retaining tabs whose assets exist", async () => {
    const { service, loaded } = await scaffolded();
    const documents = new DocumentService();
    const sceneId = documentId({ kind: "scene", path: "assets/Removed.scene.hasset" });
    const graphId = documentId({ kind: "graph", path: MAIN_CLASS_FILE });
    await documents.initializeFromProject(service, loaded.document, { documents: {}, tabOrder: [sceneId, graphId] });
    expect(documents.getDocument(sceneId)).toBeUndefined();
    // Restored tabs stay cold until activated; the retained one must still load.
    expect(documents.getState().tabOrder).toContain(graphId);
    await documents.openDocument(service, { kind: "graph", path: MAIN_CLASS_FILE, label: "Main" });
    expect(documents.getDocument(graphId)?.content).toMatchObject({ nodes: [], edges: [] });
  });

  it("renames a Class without detaching scene instances, child Classes, or project settings", async () => {
    const { service, storage, loaded } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    const childPath = "assets/Child.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [], components: [createMeshComponent("body", "sphere")] }, { parentClass: "Actor" });
    await service.saveDocument("graph", childPath, { nodes: [], edges: [], properties: { "default:classId": "Hero", label: "Hero" } }, { parentClass: "Hero" });
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero" })] });
    await service.saveProject({ ...loaded.document, settings: { ...loaded.document.settings, gameInstanceClass: "Hero" } }, loaded.layouts);
    const sourceGuid = service.guidForPath(sourcePath)!;
    const renamed = await service.renameAsset(sourceGuid, "Champion");
    const fresh = new ProjectService(storage);
    const reopened = await fresh.loadCurrentProject();
    expect(renamed.path).toBe("assets/Champion.class.hasset");
    expect(fresh.guidForPath(renamed.path)).toBe(sourceGuid);
    expect((await fresh.loadDocument("scene", MAIN_SCENE_FILE) as SerializedScene).actors[0]).toMatchObject({ id: "hero", name: "Hero", classId: "Champion" });
    expect(readAssetDocumentHeader(await storage.readBinary(childPath)).parentClass).toBe("Champion");
    expect(await fresh.loadDocument("graph", childPath)).toMatchObject({ properties: { "default:classId": "Champion", label: "Hero" } });
    expect(reopened.document.settings.gameInstanceClass).toBe("Champion");
  });

  it("rejects renaming a project Class to an engine Class before writing references", async () => {
    const { service, storage } = await scaffolded();
    const guid = service.guidForPath(MAIN_CLASS_FILE)!;
    const bytes = await storage.readBinary(MAIN_CLASS_FILE);
    await expect(service.renameAsset(guid, "Actor")).rejects.toThrow(/engine class name/);
    expect(await storage.readBinary(MAIN_CLASS_FILE)).toEqual(bytes);
    expect(service.registry!.getByGuid(guid)?.path).toBe(MAIN_CLASS_FILE);
  });

  it.each([false, true])("restores the Class path if a dependent scene write fails (persistent: %s)", async (persistent) => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero" })] });
    const sourceGuid = service.guidForPath(sourcePath)!;
    const sceneBytes = await storage.readBinary(MAIN_SCENE_FILE);
    const write = storage.writeBinary.bind(storage);
    let fail = true;
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === MAIN_SCENE_FILE && (fail || persistent)) { fail = false; throw new Error("Disk full"); }
      return write(path, bytes);
    });
    await expect(service.renameAsset(sourceGuid, "Champion")).rejects.toThrow(persistent ? /could not be restored/ : "Disk full");
    expect(await storage.exists(sourcePath)).toBe(true);
    expect(await storage.exists("assets/Champion.class.hasset")).toBe(false);
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(sceneBytes);
    expect(service.registry!.getByGuid(sourceGuid)?.path).toBe(sourcePath);
  });

  it.each(["read", "decode"])("rejects a Class %s failure instead of opening an empty graph", async (failure) => {
    const { service, storage } = await scaffolded();
    const path = "assets/Unreadable.class.hasset";
    await service.saveDocument("graph", path, { nodes: [], edges: [], properties: { label: "Keep me" } });
    if (failure === "decode") await storage.writeBinary(path, new Uint8Array([1, 2, 3]));
    const bytes = await storage.readBinary(path);
    const read = storage.readBinaryRange.bind(storage);
    const readSpy = vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      if (failure === "read" && args[0] === path) throw new Error("Storage temporarily unavailable");
      return read(...args);
    });
    const documents = new DocumentService();
    await expect(documents.openDocument(service, { kind: "graph", path, label: "Unreadable" })).rejects.toThrow();
    expect(documents.getDocument(documentId({ kind: "graph", path }))).toBeUndefined();
    readSpy.mockRestore();
    expect(await storage.readBinary(path)).toEqual(bytes);
  });

  it.each([true, false])("refuses to save over an asset it cannot read (indexed=%s)", async (indexed) => {
    const { service, storage } = await scaffolded();
    const path = "assets/Corrupt.class.hasset";
    // An indexed file keeps its GUID but not its chunks; an unindexed one has neither.
    if (indexed) await service.saveDocument("graph", path, { nodes: [], edges: [] });
    const corrupt = new Uint8Array([1, 2, 3]);
    await storage.writeBinary(path, corrupt);
    await expect(service.saveDocument("graph", path, { nodes: [], edges: [] })).rejects.toThrow(/could not be read/);
    expect(await storage.readBinary(path)).toEqual(corrupt);
  });

  it.each([false, true])("persists one Class replacement across all usages (None=%s)", async (none) => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    const replacementPath = "assets/NPC.class.hasset";
    const childPath = "assets/Child.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("graph", replacementPath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("graph", childPath, { nodes: [], edges: [], properties: { "default:classId": "Hero" } }, { parentClass: "Hero" });
    const sourceGuid = service.guidForPath(sourcePath)!;
    const replacementGuid = service.guidForPath(replacementPath)!;
    await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [
      createActor("one", "Hero", { classId: "Hero" }), createActor("two", "Second", { classId: "Hero" }),
    ] });
    await service.replaceClassReferencesBeforeDelete([
      { guid: sourceGuid, classId: "Hero", replacement: none ? null : { guid: replacementGuid, classId: "NPC" } },
    ], new Set([sourceGuid]));
    await service.registry!.deleteAsset(sourceGuid);
    const reloaded = new ProjectService(storage);
    await reloaded.loadCurrentProject();
    const scene = await reloaded.loadDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
    expect(scene.actors.map((actor) => [actor.id, actor.name, actor.classId])).toEqual([
      ["one", "Hero", none ? "Actor" : "NPC"], ["two", "Second", none ? "Actor" : "NPC"],
    ]);
    expect(readAssetDocumentHeader(await storage.readBinary(MAIN_SCENE_FILE)).dependencies).toEqual(none ? [] : [replacementGuid]);
    expect(readAssetDocumentHeader(await storage.readBinary(childPath)).parentClass).toBe(none ? "BObject" : "NPC");
    expect(reloaded.guidForPath(sourcePath)).toBeNull();
  });

  it("rejects descendant replacements before changing any saved reference", async () => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    const childPath = "assets/Child.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("graph", childPath, { nodes: [], edges: [] }, { parentClass: "Hero" });
    const sourceGuid = service.guidForPath(sourcePath)!;
    const before = await storage.readBinary(childPath);
    await expect(service.replaceClassReferencesBeforeDelete([
      { guid: sourceGuid, classId: "Hero", replacement: { guid: service.guidForPath(childPath)!, classId: "Child" } },
    ], new Set([sourceGuid]))).rejects.toThrow(/incompatible/);
    expect(await storage.readBinary(childPath)).toEqual(before);
    expect(service.guidForPath(sourcePath)).toBe(sourceGuid);
  });

  it("stops Class replacement when a referrer cannot be read, preserving its bytes and the source", async () => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    const childPath = "assets/Child.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("graph", childPath, { nodes: [], edges: [] }, { parentClass: "Hero" });
    const sourceGuid = service.guidForPath(sourcePath)!;
    const sourceBytes = await storage.readBinary(sourcePath);
    const damaged = new Uint8Array([1, 2, 3]);
    await storage.writeBinary(childPath, damaged);
    await expect(service.replaceClassReferencesBeforeDelete([
      { guid: sourceGuid, classId: "Hero", replacement: null },
    ], new Set([sourceGuid]))).rejects.toThrow();
    expect(await storage.readBinary(childPath)).toEqual(damaged);
    expect(await storage.readBinary(sourcePath)).toEqual(sourceBytes);
    expect(service.guidForPath(sourcePath)).toBe(sourceGuid);
  });

  it("restores the referrers already rewritten when a later Class replacement write fails", async () => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.hasset";
    await service.saveDocument("graph", sourcePath, { nodes: [], edges: [] }, { parentClass: "Actor" });
    await service.saveDocument("graph", "assets/A.class.hasset", { nodes: [], edges: [] }, { parentClass: "Hero" });
    await service.saveDocument("graph", "assets/B.class.hasset", { nodes: [], edges: [] }, { parentClass: "Hero" });
    const sourceGuid = service.guidForPath(sourcePath)!;
    const before = new Map(await Promise.all(["assets/A.class.hasset", "assets/B.class.hasset"].map(async (path) => [path, await storage.readBinary(path)] as const)));
    const write = storage.writeBinary.bind(storage);
    let writes = 0;
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      // The first referrer saves; the second fails, and the restores go through.
      if (before.has(path) && ++writes === 2) throw new Error("Disk full");
      return write(path, bytes);
    });
    await expect(service.replaceClassReferencesBeforeDelete([
      { guid: sourceGuid, classId: "Hero", replacement: null },
    ], new Set([sourceGuid]))).rejects.toThrow("Disk full");
    for (const [path, bytes] of before) expect(await storage.readBinary(path)).toEqual(bytes);
    expect(service.registry!.getByPath("assets/A.class.hasset")?.header.parentClass).toBe("Hero");
  });

  it("refuses to save unnamed or duplicate material parameters and keeps the saved asset intact", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Named.material.hasset";
    const doc = createDefaultMaterialDocument();
    await service.saveDocument("material", path, doc as unknown as Record<string, unknown>);
    const saved = await storage.readBinary(path);
    doc.nodes.push({ id: "parameter", type: "param.float", position: { x: 0, y: 0 }, properties: { name: " " } });
    await expect(service.saveDocument("material", path, doc as unknown as Record<string, unknown>)).rejects.toThrow(/name/i);
    expect(await storage.readBinary(path)).toEqual(saved);
    doc.nodes.at(-1)!.properties.name = "Tint";
    doc.nodes.push({ id: "copy", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint" } });
    await expect(service.saveDocument("material", path, doc as unknown as Record<string, unknown>)).rejects.toThrow(/unique|already/i);
    expect(await storage.readBinary(path)).toEqual(saved);
  });
  it("H17: indexes saved scene and class assignments by asset identity, including after reload and bake", async () => {
    const { storage, service } = await scaffolded();
    const classPath = "assets/My Hero.class.hasset";
    const matPath = "assets/Assigned.material.hasset";
    const replacementPath = "assets/Replacement.material.hasset";
    await service.saveDocument("material", matPath, {});
    await service.saveDocument("material", replacementPath, {});
    const materialGuid = service.guidForPath(matPath)!;
    const replacementGuid = service.guidForPath(replacementPath)!;
    const mesh = createMeshComponent("mesh", "sphere");
    mesh.properties.materialGuid = materialGuid;
    await service.saveDocument("graph", classPath, {
      nodes: [],
      edges: [],
      components: [mesh],
    });
    const classGuid = service.guidForPath(classPath)!;
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("instance", "Different Display Name", {
          classId: "My_Hero",
          components: [mesh],
        }),
      ],
    };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    const sceneGuid = service.guidForPath(MAIN_SCENE_FILE)!;
    expect(
      readAssetDocumentHeader(await storage.readBinary(MAIN_SCENE_FILE))
        .dependencies,
    ).toEqual([classGuid, materialGuid].sort());
    expect(service.registry!.showReferences(classGuid).inbound).toContain(
      sceneGuid,
    );
    expect(
      service.registry!.showReferences(materialGuid).inbound.sort(),
    ).toEqual([sceneGuid, classGuid].sort());

    const reloaded = new ProjectService(storage);
    await reloaded.loadCurrentProject();
    expect(reloaded.registry!.showReferences(classGuid).inbound).toContain(
      sceneGuid,
    );
    expect(
      reloaded.registry!.showReferences(materialGuid).inbound.sort(),
    ).toEqual([sceneGuid, classGuid].sort());
    const replacement = {
      ...scene,
      actors: scene.actors.map((actor) => ({
        ...actor,
        components: [
          {
            ...mesh,
            properties: { ...mesh.properties, materialGuid: replacementGuid },
          },
        ],
      })),
    };
    await reloaded.saveDocument("scene", MAIN_SCENE_FILE, replacement);
    expect(reloaded.registry!.showReferences(materialGuid).inbound).toEqual([
      classGuid,
    ]);
    expect(reloaded.registry!.showReferences(replacementGuid).inbound).toEqual([
      sceneGuid,
    ]);
    await reloaded.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      new Uint8Array([1]),
      replacement as unknown as Record<string, unknown>,
    );
    await reloaded.writeSceneAudioReverbChunk(
      MAIN_SCENE_FILE,
      new Uint8Array([2]),
      replacement as unknown as Record<string, unknown>,
    );
    expect(
      readAssetDocumentHeader(await storage.readBinary(MAIN_SCENE_FILE))
        .dependencies,
    ).toEqual([classGuid, replacementGuid].sort());
    expect(reloaded.registry!.showReferences(replacementGuid).inbound).toEqual([
      sceneGuid,
    ]);
  });

  it("H17: ignores identity and text fields that happen to equal an asset guid", async () => {
    const { storage, service } = await scaffolded();
    await service.saveDocument(
      "material",
      "assets/Unassigned.material.hasset",
      {},
    );
    const guid = service.guidForPath("assets/Unassigned.material.hasset")!;
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor(guid, guid, {
          parentId: guid,
          components: [
            {
              id: guid,
              classId: "MeshComponent",
              parentId: null,
              sourceId: guid,
              properties: { label: guid, materialGuid: null, assetGuid: "" },
            },
          ],
        }),
      ],
    };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    expect(
      readAssetDocumentHeader(await storage.readBinary(MAIN_SCENE_FILE))
        .dependencies,
    ).toEqual([]);
    expect(service.registry!.showReferences(guid).inbound).toEqual([]);
  });

  it("scaffolds scene and graph assets under assets/", async () => {
    const { storage, loaded } = await scaffolded(true);
    expect(loaded.document.scenes).toEqual([MAIN_SCENE_FILE]);
    expect(await storage.exists(MAIN_SCENE_FILE)).toBe(true);
    expect(await storage.exists(DEFAULT_3D_CLASS_FILE)).toBe(true);
    expect(await storage.exists(MAIN_CLASS_FILE)).toBe(false);
    expect(loaded.document.graphs).toEqual([DEFAULT_3D_CLASS_FILE]);
    expect(await storage.exists("assets/.blobs")).toBe(true);
    expect(await storage.exists(PROJECT_FILE)).toBe(true);
    const sceneGuid = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    ).guid;
    expect(loaded.document.settings.startupSceneGuid).toBe(sceneGuid);
  });

  it("keeps startupSceneGuid after the default scene file is renamed", async () => {
    const { storage, loaded } = await scaffolded();
    const guid = loaded.document.settings.startupSceneGuid;
    expect(guid).toBeTruthy();
    const stored = JSON.parse(await storage.readText(PROJECT_FILE)) as {
      settings: { startupSceneGuid: string | null };
    };
    expect(stored.settings.startupSceneGuid).toBe(guid);
  });

  it("writes headers the registry can read without decoding payloads", async () => {
    const { storage } = await scaffolded();
    const header = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    );
    expect(header.type).toBe("Scene");
    expect(header.version).toBe(4);
    expect(header.guid).toBeTruthy();
    expect(header.chunks[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips scene and graph content through the codec", async () => {
    const { storage, service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const graph = (await service.loadDocument("graph", MAIN_CLASS_FILE)) as {
      name?: string;
      components?: unknown[];
    };
    expect(scene.actors.find((actor) => actor.id === "actor-1")?.name).toBe(
      "Actor",
    );
    expect(graph.components?.length).toBeGreaterThan(0);
    const classHeader = readAssetDocumentHeader(
      await storage.readBinary(MAIN_CLASS_FILE),
    );
    expect(classHeader.type).toBe("Class");
    expect(classHeader.parentClass).toBe("Actor");
    expect(classHeader.name).toBe("Main");
  });

  it("keeps an asset guid stable across saves", async () => {
    const { storage, service } = await scaffolded();
    const before = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    ).guid;

    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    await service.saveDocument("scene", MAIN_SCENE_FILE, {
      ...scene,
      name: "Renamed",
    });

    const after = readAssetDocumentHeader(
      await storage.readBinary(MAIN_SCENE_FILE),
    ).guid;
    expect(after).toBe(before);
    expect(
      (
        (await service.loadDocument(
          "scene",
          MAIN_SCENE_FILE,
        )) as SerializedScene
      ).name,
    ).toBe("Renamed");
  });

  it("does not rebuild a search index on project open", async () => {
    const { service } = await scaffolded();
    expect(service.searchIndex).toBeTruthy();
    expect(service.searchIndex!.size).toBe(0);
    expect(service.searchIndex!.query("mannequin")).toEqual([]);
  });

  it("finds the default Mannequin actor after an explicit search rebuild", async () => {
    const { service } = await scaffolded(true);
    await service.searchIndex!.rebuild(service.registry!);
    const hits = service.searchIndex!.query("mannequin");
    expect(
      hits.some((hit) => hit.kind === "actor" && hit.label === "Mannequin"),
    ).toBe(true);
  });

  // Both full-project rebuilds yield between assets and perform real codec work.
  it("does not update search hits on save until the next rebuild", async () => {
    const { service } = await scaffolded();
    await service.searchIndex!.rebuild(service.registry!);
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    await service.saveDocument("scene", MAIN_SCENE_FILE, {
      ...scene,
      actors: scene.actors.map((actor) =>
        actor.id === "actor-1" ? { ...actor, name: "RenamedHero" } : actor,
      ),
    });
    expect(
      service
        .searchIndex!.query("actor")
        .some((hit) => hit.kind === "actor" && hit.label === "Actor"),
    ).toBe(true);
    expect(
      service
        .searchIndex!.query("renamedhero")
        .some((hit) => hit.kind === "actor"),
    ).toBe(false);

    await service.searchIndex!.rebuild(service.registry!);
    expect(
      service
        .searchIndex!.query("actor")
        .some((hit) => hit.kind === "actor" && hit.label === "Actor"),
    ).toBe(false);
    expect(
      service
        .searchIndex!.query("renamedhero")
        .some((hit) => hit.kind === "actor"),
    ).toBe(true);
  }, 20_000);

  it("scaffolds Kenney Mannequin as a hierarchy rig with idle Anim Graph", async () => {
    const { storage, service } = await scaffolded(true);
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const actor = scene.actors.find((entry) => entry.id === "actor-1");
    expect(actor?.name).toBe("Mannequin");
    expect(actor?.classId).toBe("Mannequin");
    const mesh = actor?.components.find(
      (component) => component.classId === "MeshComponent",
    );
    const animGraph = actor?.components.find(
      (component) => component.classId === "AnimationGraphComponent",
    );
    expect(mesh?.properties.assetGuid).toEqual(expect.any(String));
    expect(animGraph?.properties.graphGuid).toEqual(expect.any(String));

    const registry = service.registry;
    expect(registry).toBeTruthy();
    const model = registry!
      .list()
      .find((asset) => asset.header.type === "Model");
    const skeleton = registry!
      .list()
      .find((asset) => asset.header.type === "Skeleton");
    const animations = registry!
      .list()
      .filter((asset) => asset.header.type === "Animation");
    const material = registry!.list().find((asset) => asset.header.type === "Material")!;
    const materialDoc = await decodeAssetDocument(await storage.readBinary(material.path));
    expect(materialDoc.payload.shadingModel).toBe("pbr");
    expect(model?.header.payload.materialSlots).toEqual([
      expect.objectContaining({ index: 0, materialGuid: material.header.guid }),
    ]);
    expect(model?.header.name).toBe("mannequin");
    expect(mesh?.properties.assetGuid).toBe(model?.header.guid);
    expect(normalizeSkeletonPayload(skeleton?.header.payload).kind).toBe(
      "hierarchy",
    );
    expect(animations).toHaveLength(27);
    const idle = animations.find(
      (asset) =>
        normalizeAnimationPayload(
          asset.header.payload,
        ).clipName.toLowerCase() === "idle",
    );
    expect(idle).toBeTruthy();

    expect(await storage.exists("assets/Mannequin.class.hasset")).toBe(true);
    expect(await storage.exists("assets/main.class.hasset")).toBe(false);
    expect(
      await storage.exists("assets/Mannequin/Mannequin.anim.hasset"),
    ).toBe(true);
    const classHeader = readAssetDocumentHeader(
      await storage.readBinary("assets/Mannequin.class.hasset"),
    );
    expect(classHeader.type).toBe("Class");
    expect(classHeader.parentClass).toBe("Actor");
    expect(classHeader.name).toBe("Mannequin");

    const graphDoc = await decodeAssetDocument(
      await storage.readBinary("assets/Mannequin/Mannequin.anim.hasset"),
    );
    expect(graphDoc.type).toBe("AnimationGraph");
    const clips = (
      graphDoc.payload as { clips?: Array<{ assetGuid?: string }> }
    ).clips;
    expect(clips?.[0]?.assetGuid).toBe(idle!.header.guid);
    expect(animGraph?.properties.graphGuid).toBe(graphDoc.guid);
  });

  it("leaves 2D Empty camera-only without a Mannequin Model", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const service = new ProjectService(storage);
    await service.createEmptyProject("TwoDEmpty", { kind: "2d" });
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    expect(scene).toEqual(createDefaultScene("2d"));
    expect(
      service.registry?.list().some((asset) => asset.header.type === "Model"),
    ).toBe(false);
  });

  it("opens an imported Font (header payload, no document chunk) and keeps source bytes on save", async () => {
    const { storage, service } = await scaffolded();
    const source = new Uint8Array([10, 11, 12, 13]);
    const path = "assets/Ui.hasset";
    await storage.writeBinary(
      path,
      await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "font-guid",
          type: "Font",
          name: "Ui",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { family: "Ui", weight: 400, style: "normal" },
        },
        chunks: [
          { id: "source", kind: "font", mime: "font/woff2", data: source },
        ],
      }),
    );

    const payload = (await service.loadDocument("font", path)) as Record<
      string,
      unknown
    >;
    expect(payload.family).toBe("Ui");
    expect(await service.readAssetChunk(path, "source")).toEqual(source);

    await service.saveDocument("font", path, {
      ...payload,
      family: "Ui Display",
    });
    const saved = await decodeHasset(await storage.readBinary(path));
    expect(saved.chunks.get("source")).toEqual(source);
    // The whole payload stays in the header, where an MSDF attach merges.
    expect(saved.header.payload).toMatchObject({ family: "Ui Display", weight: 400, style: "normal" });
    expect(saved.header.chunks.some((chunk) => chunk.id === "document")).toBe(false);
    const reloaded = (await service.loadDocument("font", path)) as Record<
      string,
      unknown
    >;
    expect(reloaded.family).toBe("Ui Display");
  });

  it("saves Texture settings onto the header without dropping pixel chunks", async () => {
    const { storage, service } = await scaffolded();
    const pixels = new Uint8Array([9, 8, 7, 6]);
    const path = "assets/hero.hasset";
    await storage.writeBinary(
      path,
      await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "tex-guid",
          type: "Texture",
          name: "hero",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { usage: "albedo", compressionState: "compressed" },
        },
        chunks: [
          { id: "pixels", kind: "image", mime: "image/png", data: pixels },
        ],
      }),
    );

    const payload = (await service.loadDocument(
      "texture",
      path,
    )) as Record<string, unknown>;
    expect(payload.usage).toBe("albedo");
    await service.saveDocument("texture", path, {
      ...payload,
      usage: "pixelArt",
    });

    const saved = await decodeHasset(await storage.readBinary(path));
    expect(saved.header.type).toBe("Texture");
    expect(saved.header.payload.usage).toBe("pixelArt");
    expect(saved.chunks.get("pixels")).toEqual(pixels);
    expect(saved.header.chunks.some((chunk) => chunk.id === "document")).toBe(
      false,
    );
  });

  it("keeps an encode committed while the Texture was open when saving it", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/spark.hasset";
    await storage.writeBinary(
      path,
      await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "tex-spark",
          type: "Texture",
          name: "spark",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: { usage: "albedo", compressionState: "encode_failed", encodeError: "Basis failed" },
        },
        chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([9]) }],
      }),
    );
    const registry = service.registry!;
    expect(await registry.reindexPath(path)).not.toBeNull();
    const opened = (await service.loadDocument("texture", path)) as Record<string, unknown>;
    const ktx2 = ktx2Header(4, 4);
    await registry.commitCompressedTexture({
      assetGuid: "tex-spark",
      ktx2,
      wallMs: 5,
      settings: { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, blockAlign: 4 },
    });
    const committed = registry.getByGuid("tex-spark")!.header.payload.ktx2ChunkId as string;

    await service.saveDocument("texture", path, { ...opened, usage: "particle" });

    const saved = await decodeHasset(await storage.readBinary(path));
    expect(saved.header.payload).toMatchObject({
      usage: "particle",
      compressionState: "compressed",
      ktx2ChunkId: committed,
      encodeWallMs: 5,
      // What the alignment pass reads instead of the chunk.
      ktx2Width: 4,
      ktx2Height: 4,
      ktx2BlockAlign: 4,
      ktx2Sha256: await sha256Hex(ktx2),
    });
    expect(saved.header.payload).not.toHaveProperty("encodeError");
    expect(saved.chunks.get(committed)).toEqual(ktx2);
  });

  it("keeps a cube converted again at a new Face Size while the Texture was open when saving it", async () => {
    const { storage, service } = await scaffolded();
    const registry = service.registry!;
    const [sky] = await registry.importFile("project", "", "Sky.hdr", buildRadianceHdrFixture({ width: 64, height: 32, color: () => [1, 1, 1] }), { hdrFaceSize: 128 });
    const opened = (await service.loadDocument("texture", sky!.path)) as Record<string, unknown>;
    await registry.reconvertHdrEnvironment(sky!.header.guid, 512, async () => buildFloatDdsCubeFixture({ size: 4, halfFloat: true }));

    // The tab still holds the 16 × 16 cube it opened with.
    await service.saveDocument("texture", sky!.path, { ...opened });

    const saved = await decodeHasset(await storage.readBinary(sky!.path));
    expect(saved.header.payload).toMatchObject({ hdrFaceSize: 512, width: 4, height: 4, mipLevels: 3 });
    expect(readEnvironmentTextureInfo(saved.chunks.get("source")!)).toMatchObject({ width: 4 });
  });

  it("keeps a Tileset's texture at its own size, even when picked mid-encode, and pads it again once no atlas uses it", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Atlas.hproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage, {
      // Stand-in encoder: a KTX2 header at the size the real encoders produce.
      encode: async (source, settings) => {
        const size = sniffImageSize(source)!;
        const encoded = textureEncodeSize(size.width, size.height, settings);
        return { ktx2: ktx2Header(encoded.width, encoded.height), wallMs: 0 };
      },
    });
    await service.loadCurrentProject();
    const registry = service.registry!;
    const encoded = () => {
      const payload = registry.getByGuid(texture!.header.guid)!.header.payload;
      return [payload.compressionState, payload.ktx2Width, payload.ktx2Height, payload.ktx2BlockAlign];
    };

    service.pauseTextureEncodeQueue();
    const [texture] = await registry.importFile("project", "", "odd.png", pngHeader(1, 1));
    const tilesetPath = "assets/Ground.tileset.hasset";
    await service.saveDocument("tileset", tilesetPath, { ...createDefaultTilesetPayload(), textureGuid: texture!.header.guid });
    expect(readAssetDocumentHeader(await storage.readBinary(tilesetPath)).payload.atlasTextures).toEqual([texture!.header.guid]);
    // The import encode was queued padded, before the Tileset used the texture.
    service.resumeTextureEncodeQueue();
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 1, 1, undefined]));

    await registry.deleteAsset(service.guidForPath(tilesetPath)!);
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 4, 4, 4]));
  });

  it("keeps the Particle encode of an unsaved Texture Details Usage through a remount, then saves it", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Unsaved.hproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage, {
      encode: async (source, settings) => {
        const size = sniffImageSize(source)!;
        const encoded = textureEncodeSize(size.width, size.height, settings);
        return { ktx2: ktx2Header(encoded.width, encoded.height), wallMs: 0 };
      },
    });
    await service.loadCurrentProject();
    const [texture] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    const guid = texture!.header.guid;
    // The editor's guard: an open Texture tab's Usage, once Details changes it.
    const tabUsages = new Map<string, string>();
    service.setOpenTextureUsage((id) => tabUsages.get(id));
    const payload = () => service.registry!.getByGuid(guid)!.header.payload;
    const encoded = () => [payload().compressionState, payload().ktx2Width, payload().ktx2Height, payload().ktx2BlockAlign];
    await service.saveDocument("tileset", "assets/Ground.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: guid });
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 1, 1, undefined]));
    const opened = (await service.loadDocument("texture", texture!.path)) as Record<string, unknown>;

    // Details sets Usage to Particle without saving: Particle pads even an atlas.
    tabUsages.set(guid, "particle");
    await service.retryTextureEncoding(guid, { force: true, usage: "particle" });
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 4, 4, 4]));
    const particleChunkId = payload().ktx2ChunkId;

    // Remounting metadata must preserve the unsaved encode without processing it.
    await vi.waitFor(() => expect(service.textureAlignmentState.pending).toBe(0));
    const alignment = service.textureAlignmentState;
    await service.remountRegistry();
    expect(service.textureAlignmentState).toEqual(alignment);
    expect(encoded()).toEqual(["compressed", 4, 4, 4]);
    expect(payload().ktx2ChunkId).toBe(particleChunkId);

    await service.saveDocument("texture", texture!.path, { ...opened, usage: "particle" });
    const saved = await decodeHasset(await storage.readBinary(texture!.path));
    expect(saved.header.payload).toMatchObject({ usage: "particle", ktx2ChunkId: particleChunkId, ktx2BlockAlign: 4 });
  });

  it("leaves an old odd Texture unread on project open and encodes it on explicit Retry", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Solo.hproject");
    await installMinimalProject(storage);
    await writeLegacyOddTexture(storage, "assets/odd.hasset", "odd");
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });

    await service.loadCurrentProject();
    expect(encode).not.toHaveBeenCalled();
    expect(service.registry!.getByGuid("odd")!.header.payload).not.toHaveProperty("ktx2Width");
    expect(service.registry!.payloadLoader.snapshot().recentRequests.filter(request => request.path === "assets/odd.hasset")).toEqual([]);
    expect(await service.retryTextureEncoding("odd", { force: true })).toBe(true);
    await vi.waitFor(() =>
      expect(service.registry!.getByGuid("odd")!.header.payload).toMatchObject({
        compressionState: "compressed",
        ktx2ChunkId: KTX2_KEY_MAX_1,
        ktx2Width: 4,
        ktx2Height: 4,
      }),
    );
  });

  it("requires explicit Retry for old odd Textures before and after source control is turned off", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("SharedOdd.hproject");
    await installMinimalProject(storage);
    await enableSourceControlOnDisk(storage);
    await writeLegacyOddTexture(storage, "assets/retried.hasset", "retried");
    await writeLegacyOddTexture(storage, "assets/waiting.hasset", "waiting");
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });
    const payload = (guid: string) => service.registry!.getByGuid(guid)!.header.payload;

    await service.loadCurrentProject();
    // Explicit maintenance respects shared files, including after a catalog remount.
    expect(await service.reconcileTextureAlignment()).toBe(0);
    await service.remountRegistry();
    expect(await service.reconcileTextureAlignment()).toBe(0);
    expect(service.textureEncodeQueue.depth).toBe(0);
    expect(encode).not.toHaveBeenCalled();
    // So Texture Details offers Retry Encoding for both.
    expect(await service.textureAlignmentStale("retried")).toBe(true);
    expect(await service.textureAlignmentStale("waiting")).toBe(true);

    // Retry Encoding, and every Details change that re-encodes, makes this call.
    expect(await service.retryTextureEncoding("retried", { force: true, usage: "albedo" })).toBe(true);
    await vi.waitFor(() => expect(payload("retried")).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 }));
    expect(payload("waiting")).toMatchObject({ compressionState: "compressed", ktx2ChunkId: KTX2_KEY_MAX_1 });
    expect(payload("waiting")).not.toHaveProperty("ktx2Width");
    expect(await service.textureAlignmentStale("retried")).toBe(false);

    // Changing permissions starts no reads or jobs; the other Texture still needs Retry.
    await vi.waitFor(() => expect(service.textureAlignmentState.pending).toBe(0));
    const alignment = service.textureAlignmentState;
    const reads = storage.getReadMetrics();
    service.setSourceControlEnabled(false);
    expect(service.textureAlignmentState).toEqual(alignment);
    expect(storage.getReadMetrics()).toEqual(reads);
    expect(payload("waiting")).not.toHaveProperty("ktx2Width");
    expect(encode).toHaveBeenCalledTimes(1);
    expect(await service.retryTextureEncoding("waiting", { force: true })).toBe(true);
    await vi.waitFor(() => expect(payload("waiting")).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 }));
    expect(encode).toHaveBeenCalledTimes(2);
    expect(await service.textureAlignmentStale("waiting")).toBe(false);
  });

  it("with source control on, keeps a Tileset's texture at its own size only when this session padded it or created its file", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Shared.hproject");
    await installMinimalProject(storage);
    await enableSourceControlOnDisk(storage);
    // Padded by an earlier session: a teammate may be changing it.
    const legacyPath = "assets/legacy-padded.hasset";
    await storage.writeBinary(legacyPath, await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "legacy-padded", type: "Texture", name: "legacy-padded", engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
        payload: {
          usage: "albedo", compressionState: "compressed", ktx2ChunkId: KTX2_KEY_MAX_1, width: 1, height: 1,
          ktx2Width: 4, ktx2Height: 4, ktx2BlockAlign: 4, ktx2Sha256: await sha256Hex(ktx2Header(4, 4)),
        },
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "image/png", data: pngHeader(1, 1) },
        { id: KTX2_KEY_MAX_1, kind: "ktx2", mime: "image/ktx2", data: ktx2Header(4, 4) },
      ],
    }));
    const service = new ProjectService(storage, { encode: standInEncode });
    await service.loadCurrentProject();
    const registry = service.registry!;
    const [texture] = await registry.importFile("project", "", "odd.png", pngHeader(1, 1));
    const encoded = (guid: string) => {
      const payload = registry.getByGuid(guid)!.header.payload;
      return [payload.compressionState, payload.ktx2Width, payload.ktx2Height, payload.ktx2BlockAlign];
    };
    await vi.waitFor(() => expect(encoded(texture!.header.guid)).toEqual(["compressed", 4, 4, 4]));
    // New files carrying the earlier session's padded encode: a Duplicate and a .hasset import.
    const copy = await registry.duplicateAsset("legacy-padded", "project");
    const [imported] = await registry.importFile("project", "incoming", "incoming.hasset", await storage.readBinary(legacyPath));
    expect(imported!.header.guid).not.toBe("legacy-padded");
    for (const created of [copy, imported!]) expect(encoded(created.header.guid)).toEqual(["compressed", 4, 4, 4]);

    await service.saveDocument("tileset", "assets/Old.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: "legacy-padded" });
    await service.saveDocument("tileset", "assets/New.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: texture!.header.guid });
    await service.saveDocument("tileset", "assets/Copy.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: copy.header.guid });
    await service.saveDocument("tileset", "assets/Imported.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: imported!.header.guid });
    // The import's padding was this session's own write, and so were the new files, so it is undone...
    await vi.waitFor(() => {
      for (const guid of [texture!.header.guid, copy.header.guid, imported!.header.guid]) {
        expect(encoded(guid)).toEqual(["compressed", 1, 1, undefined]);
      }
    });
    // ...while the earlier session's padded atlas waits for the user's own edit.
    expect(await service.reconcileTextureAlignment(["legacy-padded"])).toBe(0);
    expect(encoded("legacy-padded")).toEqual(["compressed", 4, 4, 4]);
  });

  it("with source control on, leaves an encode a git revert restored alone, though this session re-encoded the Texture before", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Reverted.hproject");
    await installMinimalProject(storage);
    const path = "assets/odd.hasset";
    await writeLegacyOddTexture(storage, path, "odd");
    const committedInGit = await storage.readBinary(path);
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });
    const payload = () => service.registry!.getByGuid("odd")!.header.payload;

    // Explicit maintenance with source control off re-encodes it on the grid.
    await service.loadCurrentProject();
    await service.reconcileTextureAlignment(["odd"]);
    await vi.waitFor(() => expect(payload()).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 }));
    // Project Settings turns source control on, and a git client restores the committed file.
    service.setSourceControlEnabled(true);
    await nextMillisecond();
    await storage.writeBinary(path, committedInGit);

    // Returning to the app remounts metadata; a requested pass still respects the revert.
    service.pauseTextureEncodeQueue();
    await service.remountRegistry();
    expect(await service.reconcileTextureAlignment()).toBe(0);
    expect(service.textureEncodeQueue.depth).toBe(0);
    service.resumeTextureEncodeQueue();
    expect(encode).toHaveBeenCalledTimes(1);
    expect(payload()).toMatchObject({ compressionState: "compressed", ktx2ChunkId: KTX2_KEY_MAX_1 });
    expect(payload()).not.toHaveProperty("ktx2Width");
  });

  it("with source control on, writes nothing from this session's queued re-encode once a git revert restored the file, even without a rescan", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("RevertedQueued.hproject");
    await installMinimalProject(storage);
    const path = "assets/odd.hasset";
    await writeLegacyOddTexture(storage, path, "odd");
    const committedInGit = await storage.readBinary(path);
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });

    // Explicit maintenance with source control off pads it on the grid.
    await service.loadCurrentProject();
    await service.reconcileTextureAlignment(["odd"]);
    await vi.waitFor(() => expect(service.registry!.getByGuid("odd")!.header.payload).toMatchObject({ ktx2Width: 4, ktx2BlockAlign: 4 }));
    service.setSourceControlEnabled(true);
    // A Tileset picks it while the queue is paused: the padding is this
    // session's own, so a re-encode at its own size is queued.
    service.pauseTextureEncodeQueue();
    await service.saveDocument("tileset", "assets/Ground.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: "odd" });
    await vi.waitFor(() => expect(service.textureEncodeQueue.depth).toBe(1));
    // A git client restores the committed file; the window only lost focus, so nothing rescans.
    await nextMillisecond();
    await storage.writeBinary(path, committedInGit);

    service.resumeTextureEncodeQueue();
    await vi.waitFor(() => expect(service.textureEncodeQueue.depth).toBe(0));
    expect(encode).toHaveBeenCalledTimes(2);
    expect(await storage.readBinary(path)).toEqual(committedInGit);
  });

  it("rechecks a Texture a Tileset picks while an unsaved Details Usage re-encodes it", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("InFlight.hproject");
    await installMinimalProject(storage);
    const service = new ProjectService(storage, { encode: standInEncode });
    await service.loadCurrentProject();
    const tabUsages = new Map<string, string>();
    service.setOpenTextureUsage((id) => tabUsages.get(id));
    const registry = service.registry!;
    const [texture] = await registry.importFile("project", "", "odd.png", pngHeader(1, 1));
    const guid = texture!.header.guid;
    const encoded = () => {
      const payload = registry.getByGuid(guid)!.header.payload;
      return [payload.compressionState, payload.ktx2Width, payload.ktx2Height, payload.ktx2BlockAlign];
    };
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 4, 4, 4]));

    // Texture Details sets Usage to Normal without saving; its encode is queued padded.
    service.pauseTextureEncodeQueue();
    tabUsages.set(guid, "normal");
    await service.retryTextureEncoding(guid, { force: true, usage: "normal" });
    // A Tileset picks the texture while that encode waits: the pass leaves a pending encode alone.
    const runs = service.textureAlignmentState.runs;
    await service.saveDocument("tileset", "assets/Ground.tileset.hasset", { ...createDefaultTilesetPayload(), textureGuid: guid });
    await vi.waitFor(() => {
      expect(service.textureAlignmentState.runs).toBeGreaterThan(runs);
      expect(service.textureAlignmentState.pending).toBe(0);
    });
    expect(encoded()[0]).toBe("pending");
    service.resumeTextureEncodeQueue();

    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 1, 1, undefined]));
  });

  it("does not report its own alignment re-encodes as external changes on a foreground rescan", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Rescan.hproject");
    await installMinimalProject(storage);
    const paths = Array.from({ length: 8 }, (_, index) => `assets/odd-${index}.hasset`);
    for (const [index, path] of paths.entries()) await writeLegacyOddTexture(storage, path, `odd-${index}`);
    // Open with source control on, then request maintenance explicitly below.
    await enableSourceControlOnDisk(storage);
    const service = new ProjectService(storage, { encode: standInEncode });
    await service.loadCurrentProject();
    // The editor's mtime snapshot at open, kept current with the editor's own writes.
    const snapshot = snapshotIndexedMtimes(service.registry!.list());
    const atOpen = { ...snapshot };
    service.onOwnAssetWrite((write) => applyOwnAssetWrite(snapshot, write));
    // A teammate's change to one Texture lands before the pass rewrites it.
    await nextMillisecond();
    await storage.writeBinary(paths[0]!, await storage.readBinary(paths[0]!));
    await nextMillisecond();

    service.setSourceControlEnabled(false);
    await service.reconcileTextureAlignment();
    await vi.waitFor(() => {
      expect(service.textureEncodeQueue.depth).toBe(0);
      for (const path of paths) expect(service.registry!.getByPath(path)!.header.payload.ktx2Width).toBe(4);
    });
    for (const path of paths) expect((await storage.stat(path)).mtime).not.toBe(atOpen[path]);

    // What returning to the app does (`runForegroundRescan`).
    await service.remountRegistry();
    const changes = classifyExternalChanges({
      previousAssets: snapshot,
      nextAssets: snapshotIndexedMtimes(service.registry!.list()),
      previousProjectJsonMtime: null,
      nextProjectJsonMtime: null,
      openDocs: [],
    });
    expect(changes.changedPaths).toEqual([paths[0]]);
    expect(changes.kind).toBe("none");
  });

  it("stops the pass's re-encodes once source control is turned on, leaving nothing for the next open to re-encode", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("TurnedOn.hproject");
    await installMinimalProject(storage);
    const paths = ["assets/odd-a.hasset", "assets/odd-b.hasset"];
    for (const [index, path] of paths.entries()) await writeLegacyOddTexture(storage, path, `odd-${index}`);
    let releaseFirst!: () => void;
    const firstEncode = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const encode = vi.fn<EncodeFn>(async (source, settings) => {
      if (encode.mock.calls.length === 1) {
        await firstEncode;
        throw new Error("The encode worker stopped.");
      }
      return standInEncode(source, settings);
    });
    const service = new ProjectService(storage, { encode });
    const onDisk = async (path: string) => (await decodeHasset(await storage.readBinary(path))).header.payload;

    // Source control is off: explicit maintenance queues both re-encodes.
    await service.loadCurrentProject();
    await service.reconcileTextureAlignment();
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
    expect(service.textureAlignmentState.requeued.sort()).toEqual(["odd-0", "odd-1"]);
    // Project Settings turns source control on while the first re-encode runs.
    service.setSourceControlEnabled(true);
    releaseFirst();
    await vi.waitFor(() => expect(service.textureEncodeQueue.depth).toBe(0));
    // The running one's failure is not written, and the waiting one never starts.
    expect(encode).toHaveBeenCalledTimes(1);
    for (const path of paths) {
      const payload = await onDisk(path);
      expect(payload).toMatchObject({ compressionState: "compressed", ktx2ChunkId: KTX2_KEY_MAX_1 });
      expect(payload).not.toHaveProperty("encodeError");
      expect(payload).not.toHaveProperty("ktx2Width");
    }

    // The next session opens with the setting saved: nothing waits on disk for it to re-encode.
    await enableSourceControlOnDisk(storage);
    const next = new ProjectService(storage, { encode });
    await next.loadCurrentProject();
    expect(await next.reconcileTextureAlignment()).toBe(0);
    expect(next.textureEncodeQueue.depth).toBe(0);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("tells Texture Details when turning source control on leaves the pass's re-encoding and waiting Textures stale", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("TurnedOnDetails.hproject");
    await installMinimalProject(storage);
    for (const guid of ["odd-0", "odd-1"]) await writeLegacyOddTexture(storage, `assets/${guid}.hasset`, guid);
    let releaseFirst!: () => void;
    const firstEncode = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const encode = vi.fn<EncodeFn>(async (source, settings) => {
      if (encode.mock.calls.length === 1) await firstEncode;
      return standInEncode(source, settings);
    });
    const service = new ProjectService(storage, { encode });
    // What an open Texture Details shows: rechecked on every registry change, the latest check winning.
    const offered: Record<string, boolean> = {};
    let generation = 0;
    service.onRegistryChange(() => {
      const current = ++generation;
      for (const guid of ["odd-0", "odd-1"]) {
        void service.textureAlignmentStale(guid).then((stale) => {
          if (current === generation) offered[guid] = stale;
        });
      }
    });

    // Explicit maintenance queues both re-encodes, so no Retry Encoding while they run.
    await service.loadCurrentProject();
    await service.reconcileTextureAlignment();
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(offered).toEqual({ "odd-0": false, "odd-1": false }));
    // Project Settings turns source control on while the first encodes; the page is then hidden.
    service.setSourceControlEnabled(true);
    service.pauseTextureEncodeQueue();
    releaseFirst();
    // The first one's commit is refused.
    await vi.waitFor(() => expect(offered["odd-0"]).toBe(true));
    expect(offered["odd-1"]).toBe(false);
    // The waiting one is dropped once the page shows again.
    service.resumeTextureEncodeQueue();
    await vi.waitFor(() => expect(offered["odd-1"]).toBe(true));
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("refreshes a remount that captured the pending state before the encoder committed to the previous registry", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("EncodingRemount.hproject");
    await installMinimalProject(storage);
    let releaseEncode!: () => void;
    const encoding = new Promise<void>((resolve) => { releaseEncode = resolve; });
    const encode = vi.fn<EncodeFn>(async (source, settings) => {
      await encoding;
      return standInEncode(source, settings);
    });
    const service = new ProjectService(storage, { encode });
    await service.loadCurrentProject();
    const previous = service.registry!;
    const [imported] = await previous.importFile("project", "", "remount.png", pngHeader(1, 1));
    const guid = imported!.header.guid;
    const path = imported!.path;
    await vi.waitFor(() => expect(service.textureEncodingGuids.has(guid)).toBe(true));
    expect(previous.getByGuid(guid)?.header.payload.compressionState).toBe("pending");

    let capturedHeader!: () => void;
    const captured = new Promise<void>((resolve) => { capturedHeader = resolve; });
    let releaseScan!: () => void;
    const scanning = new Promise<void>((resolve) => { releaseScan = resolve; });
    const read = storage.readBinaryRange.bind(storage);
    let held = false;
    const readSpy = vi.spyOn(storage, "readBinaryRange").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[0] === path && args[1] === 12 && !held) {
        held = true;
        capturedHeader();
        await scanning;
      }
      return result;
    });
    let savedEncode!: () => void;
    const saved = new Promise<void>((resolve) => { savedEncode = resolve; });
    const unsubscribe = service.onOwnAssetWrite((write) => {
      if (write.path === path && previous.getByGuid(guid)?.header.payload.compressionState === "compressed") savedEncode();
    });
    const remount = service.remountRegistry();
    try {
      await captured;
      releaseEncode();
      await saved;
      expect(service.registry).toBe(previous);
      expect(readAssetDocumentHeader(await storage.readBinary(path)).payload.compressionState).toBe("compressed");
      releaseScan();
      await remount;
      await vi.waitFor(() => expect(service.textureEncodeQueue.depth).toBe(0));
      expect(service.registry).not.toBe(previous);
      const current = service.registry!.getByGuid(guid)!;
      expect(current.header.payload).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 });
      expect(current.header.chunks.some((chunk) => chunk.id === current.header.payload.ktx2ChunkId)).toBe(true);
      expect(encode).toHaveBeenCalledTimes(1);
      expect(service.sessionDiagnostics).toEqual([]);
    } finally {
      releaseEncode();
      releaseScan();
      await remount;
      readSpy.mockRestore();
      unsubscribe();
      service.dispose();
    }
  });

  it("encodes each Texture once however often the registry remounts while its encode waits or runs", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Backlog.hproject");
    await installMinimalProject(storage);
    const paths = ["assets/odd-a.hasset", "assets/odd-b.hasset"];
    for (const [index, path] of paths.entries()) await writeLegacyOddTexture(storage, path, `odd-${index}`);
    let releaseFirst!: () => void;
    const firstEncode = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const encode = vi.fn<EncodeFn>(async (source, settings) => {
      if (encode.mock.calls.length === 1) await firstEncode;
      return standInEncode(source, settings);
    });
    const service = new ProjectService(storage, { encode });
    const payload = (path: string) => service.registry!.getByPath(path)!.header.payload;
    const settled = () => vi.waitFor(() => expect(service.textureAlignmentState.pending).toBe(0));

    // The page is hidden: requested alignment re-encodes and an import wait in the queue.
    service.pauseTextureEncodeQueue();
    await service.loadCurrentProject();
    await service.reconcileTextureAlignment();
    await settled();
    expect(service.textureAlignmentState.requeued.sort()).toEqual(["odd-0", "odd-1"]);
    // Its re-encode waits: Texture Details offers no Retry Encoding meanwhile.
    expect(await service.textureAlignmentStale("odd-0")).toBe(false);
    const [imported] = await service.registry!.importFile("project", "", "odd.png", pngHeader(1, 1));
    // Content Browser changes and returning to the app remount the registry.
    await service.remountRegistry();
    await service.remountRegistry();
    await settled();
    expect(service.textureEncodeQueue.depth).toBe(3);

    // A re-encode runs first, still `compressed` on disk, and a remount lands while it runs.
    service.resumeTextureEncodeQueue();
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
    await service.remountRegistry();
    await settled();
    expect(service.textureEncodeQueue.depth).toBe(3);
    releaseFirst();

    await vi.waitFor(() => {
      expect(service.textureEncodeQueue.depth).toBe(0);
      for (const path of [...paths, imported!.path]) {
        expect(payload(path)).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 });
      }
    });
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it("saves Model slots onto the header without replacing the source GLB", async () => {
    const { storage, service } = await scaffolded();
    const source = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]);
    const path = "assets/hero.hasset";
    await storage.writeBinary(
      path,
      await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "model-guid",
          type: "Model",
          name: "hero",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: ["mat-old"],
          parentClass: null,
          payload: {
            clipNames: ["Walk"],
            materialSlots: [
              { index: 0, name: "Hero Mat", materialGuid: "mat-old" },
            ],
          },
        },
        chunks: [
          {
            id: "source",
            kind: "geometry",
            mime: "model/gltf-binary",
            data: source,
          },
        ],
      }),
    );

    const payload = (await service.loadDocument("model", path)) as Record<
      string,
      unknown
    >;
    await service.saveDocument("model", path, {
      ...payload,
      materialSlots: [{ index: 0, name: "Hero Mat", materialGuid: "mat-new" }],
    });

    const saved = await decodeHasset(await storage.readBinary(path));
    expect(saved.header.type).toBe("Model");
    expect(saved.header.payload.clipNames).toEqual(["Walk"]);
    expect(saved.header.payload.materialSlots).toEqual([
      { index: 0, name: "Hero Mat", materialGuid: "mat-new" },
    ]);
    expect(saved.header.dependencies).toEqual(["mat-new"]);
    expect(saved.chunks.get("source")).toEqual(source);
    expect(saved.header.chunks.some((chunk) => chunk.id === "document")).toBe(
      false,
    );
  });

  it("reports a copied asset file hidden because its guid duplicates another asset, once", async () => {
    const { storage, service } = await scaffolded();
    await storage.mkdir("assets/Copies", true);
    await storage.writeBinary("assets/Copies/main.scene.hasset", await storage.readBinary(MAIN_SCENE_FILE));
    await service.remountRegistry();
    await service.remountRegistry();
    expect(service.sessionDiagnostics.filter((line) => line.includes("assets/Copies/main.scene.hasset"))).toEqual([
      `assets/Copies/main.scene.hasset is hidden: it has the same asset id as ${MAIN_SCENE_FILE}. Remove the copy or import it again to give it its own id.`,
    ]);
  });

  it("writes a Scene navmesh extra chunk without regenerating at Play", async () => {
    const { service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const bake = new Uint8Array([11, 22, 33, 44]);
    await service.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      bake,
      scene as unknown as Record<string, unknown>,
    );
    expect(
      await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID),
    ).toEqual(bake);
    const again = new Uint8Array([99]);
    await service.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      again,
      scene as unknown as Record<string, unknown>,
    );
    expect(
      await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID),
    ).toEqual(again);
  });

  it("keeps a Scene navmesh extra chunk when saveDocument rewrites the JSON body", async () => {
    const { service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const bake = new Uint8Array(70 * 1024).fill(7);
    await service.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      bake,
      scene as unknown as Record<string, unknown>,
    );
    await service.saveDocument("scene", MAIN_SCENE_FILE, {
      ...scene,
      name: "AfterSave",
    });
    expect(
      await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID),
    ).toEqual(bake);
    expect(
      (
        (await service.loadDocument(
          "scene",
          MAIN_SCENE_FILE,
        )) as SerializedScene
      ).name,
    ).toBe("AfterSave");
  });

  it("stages reverb for dirty geometry until that Scene is saved", async () => {
    const { storage, service } = await scaffolded();
    const savedScene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, savedScene);
    const savedBytes = await storage.readBinary(MAIN_SCENE_FILE);
    const dirtyScene = structuredClone(savedScene);
    dirtyScene.name = "Unsaved rename";
    dirtyScene.actors[0]!.transform.position[0] = 50;
    const reverb = new Uint8Array([9, 8, 7]);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, reverb, dirtyScene as unknown as Record<string, unknown>);
    // Closing/discarding this tab can leave no authored or derived disk changes.
    expect(await storage.readBinary(MAIN_SCENE_FILE)).toEqual(savedBytes);
    await service.saveDocument("scene", MAIN_SCENE_FILE, dirtyScene);
    const decoded = await decodeHasset(await storage.readBinary(MAIN_SCENE_FILE));
    expect(decoded.chunks.get(AUDIO_REVERB_CHUNK_ID)).toEqual(reverb);
    expect((await service.loadDocument("scene", MAIN_SCENE_FILE) as SerializedScene).actors[0]!.transform.position[0]).toBe(50);
  });

  it("serializes reverb with Save and preserves the latest saved Scene and its other chunks", async () => {
    const { storage, service } = await scaffolded();
    const scene = await service.loadDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([4, 5]), scene as unknown as Record<string, unknown>);
    let finishWrite!: () => void;
    let startedWrite!: () => void;
    const started = new Promise<void>((resolve) => { startedWrite = resolve; });
    const gate = new Promise<void>((resolve) => { finishWrite = resolve; });
    const write = storage.writeBinary.bind(storage);
    const writes = vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path === MAIN_SCENE_FILE && writes.mock.calls.length === 1) {
        startedWrite();
        await gate;
      }
      await write(path, bytes);
    });
    const save = service.saveDocument("scene", MAIN_SCENE_FILE, { ...scene, name: "Explicitly saved" });
    await started;
    const bake = service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([7, 8]), {
      ...scene, name: "Still unsaved",
    });
    finishWrite();
    await Promise.all([save, bake]);
    writes.mockRestore();
    const bytes = await storage.readBinary(MAIN_SCENE_FILE);
    expect((await decodeAssetDocument(bytes)).payload.name).toBe("Explicitly saved");
    const decoded = await decodeHasset(bytes);
    expect(decoded.chunks.get(NAVMESH_CHUNK_ID)).toEqual(new Uint8Array([4, 5]));
    expect(decoded.chunks.get(AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([7, 8]));
  });

  it("drops an older reverb chunk when a saved edit outpaces the matching bake", async () => {
    const { service } = await scaffolded();
    const scene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([7]), scene as unknown as Record<string, unknown>);
    const lateEdit = structuredClone(scene);
    lateEdit.actors[0]!.transform.position[0] = 12;
    await service.saveDocument("scene", MAIN_SCENE_FILE, lateEdit);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toBeNull();
  });

  it("bakes the persisted Scene for export after staging unsaved geometry", async () => {
    const { storage, service } = await scaffolded();
    const scene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    let baked = 0;
    const controller = createAudioReverbBakeController({
      bake: async () => new Uint8Array([++baked]),
      write: (entry) => service.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload),
    });
    const dirty = structuredClone(scene);
    dirty.actors[0]!.transform.position[0] = 50;
    await controller.flush(MAIN_SCENE_FILE, dirty as unknown as Record<string, unknown>);
    const persisted = await collectAudioReverbFlushScenes({
      paths: [MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
    });
    await controller.flushAll(persisted.scenes);
    const saved = await decodeAssetDocument(await storage.readBinary(MAIN_SCENE_FILE));
    expect((saved.payload as unknown as SerializedScene).actors[0]!.transform.position[0]).toBe(0);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([2]));
    controller.dispose();
  });

  it("saves the reverb baked for the saved geometry when export bakes the older saved Scene before Save writes it", async () => {
    const { service } = await scaffolded();
    const scene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    const bakes: Array<(bytes: Uint8Array) => void> = [];
    // Wired as AudioReverbBakeProvider wires Save's and export's flushes.
    const controller = createAudioReverbBakeController({
      bake: () => new Promise((resolve) => { bakes.push(resolve); }),
      write: async () => { throw new Error("bakes write through withWrite"); },
      withWrite: (work) => service.withSceneWrite((writer) =>
        work((entry) => writer.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload))),
    });
    const edited = structuredClone(scene);
    edited.actors[0]!.transform.position[0] = 50;
    // Save flushes the edited Scene it is about to write.
    const saveFlush = controller.flush(MAIN_SCENE_FILE, edited as unknown as Record<string, unknown>,
      (entry) => service.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload));
    await vi.waitFor(() => expect(bakes).toHaveLength(1));
    // Export flushes the Scene still saved on disk; its bake waits for Save's.
    const persisted = await collectAudioReverbFlushScenes({
      paths: [MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
    });
    const exportFlush = controller.flushAll(persisted.scenes);
    bakes[0]!(new Uint8Array([1]));
    await saveFlush;
    await vi.waitFor(() => expect(bakes).toHaveLength(2));
    bakes[1]!(new Uint8Array([2]));
    expect((await exportFlush).size).toBe(0);
    // Export's write for the older geometry lands before Save writes the edit.
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([2]));
    await service.saveDocument("scene", MAIN_SCENE_FILE, edited);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([1]));
    controller.dispose();
  });

  it("packs a Scene's JSON, navmesh and reverb from one saved version when a Save lands between export's reads", async () => {
    const { service } = await scaffolded();
    const scene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([10]), scene as unknown as Record<string, unknown>);
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([1]), scene as unknown as Record<string, unknown>);
    const edited = structuredClone(scene);
    edited.actors[0]!.transform.position[0] = 50;
    const registry = service.registry!;
    // Snapshot loads read every chunk against the locator they resolved once.
    const readLocatedChunk = registry.readLocatedChunk.bind(registry);
    let saved = false;
    vi.spyOn(registry, "readLocatedChunk").mockImplementation(async (guid, chunkId, ...rest) => {
      if (!saved && (chunkId === NAVMESH_CHUNK_ID || chunkId === AUDIO_REVERB_CHUNK_ID)) {
        saved = true;
        // Save writes the edited geometry with its reverb and navmesh once
        // export has read the Scene JSON, before it reads the derived chunks.
        await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([2]), edited as unknown as Record<string, unknown>);
        await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([20]), edited as unknown as Record<string, unknown>);
      }
      return readLocatedChunk(guid, chunkId, ...rest);
    });
    const loaded = await loadExportDocuments({
      assets: registry.list().filter((asset) => asset.header.type === "Scene"),
      loadDocument: (_kind, path) => service.loadDocument("scene", path),
      loadDocumentWithChunks: (_kind, path, chunkIds) => service.loadDocumentWithChunks("scene", path, chunkIds),
      readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
    });
    expect(saved).toBe(true);
    const guid = service.guidForPath(MAIN_SCENE_FILE)!;
    expect({
      position: loaded.sceneByGuid(guid)!.actors[0]!.transform.position[0],
      navmesh: loaded.navmeshByGuid(guid),
      reverb: loaded.audioReverbByGuid(guid),
    }).toEqual({ position: 50, navmesh: new Uint8Array([20]), reverb: new Uint8Array([2]) });
  });

  /** Export's loaders for the asset at `path`, wired as `exportGameArtifact` wires them. */
  const exportLoaders = (service: ProjectService, path: string) => ({
    // The listing export starts from, before any Save lands.
    assets: service.registry!.list().filter((asset) => asset.path === path),
    loadDocument: (kind: string, path: string) =>
      service.loadDocument(kind as Parameters<ProjectService["loadDocument"]>[0], path),
    loadDocumentWithChunks: (kind: string, path: string, chunks: Parameters<ProjectService["loadDocumentWithChunks"]>[2]) =>
      service.loadDocumentWithChunks(kind as Parameters<ProjectService["loadDocumentWithChunks"]>[0], path, chunks),
    readAssetChunk: (path: string, chunkId: string) => service.readAssetChunk(path, chunkId),
  });

  /** Lands `save` once, just before the first read of a chunk `matches` selects. */
  function saveBeforeChunkRead(service: ProjectService, matches: (chunkId: string) => boolean, save: () => Promise<void>) {
    const registry = service.registry!;
    let saved = false;
    // Single chunk reads resolve their own locator; snapshot loads read against one.
    for (const method of ["readChunk", "readLocatedChunk"] as const) {
      const read = registry[method].bind(registry) as (...args: unknown[]) => Promise<Uint8Array>;
      vi.spyOn(registry, method).mockImplementation((async (guid: string, chunkId: string, ...rest: unknown[]) => {
        if (!saved && matches(chunkId)) {
          saved = true;
          await save();
        }
        return read(guid, chunkId, ...rest);
      }) as never);
    }
    return () => saved;
  }

  it("packs an Audio's settings and clips from one saved version when a Save lands between export's reads", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Jump.hasset";
    await storage.writeBinary(path, await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "jump", type: "Audio", name: "Jump", engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
        payload: { volume: 0.25, clips: [{ chunkId: "source", name: "Old", weight: 1 }] },
      },
      chunks: [{ id: "source", kind: "audio", mime: "audio/wav", data: new Uint8Array([1, 1]) }],
    }));
    expect(await service.registry!.reindexPath(path)).not.toBeNull();
    // Replacing the clip saves its bytes and settings together.
    const saved = saveBeforeChunkRead(service, (chunkId) => chunkId === "source", () =>
      service.writeAudioClipChunk(path, "source", new Uint8Array([2, 2]), "audio/wav",
        { volume: 0.75, clips: [{ chunkId: "source", name: "New", weight: 1 }] }));
    const loaded = await loadExportDocuments(exportLoaders(service, path));
    expect(saved()).toBe(true);
    const packed = decodePackedAudioAsset(loaded.bytesByGuid("jump")!)!;
    expect({ volume: packed.payload.volume, clip: packed.payload.clips[0]!.name, sources: packed.sources })
      .toEqual({ volume: 0.75, clip: "New", sources: [new Uint8Array([2, 2])] });
  });

  it("packs a Texture's variant, settings and area emission from one saved version when a Save lands between export's reads", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Lamp.hasset";
    const version = async (edge: number, ktx2ChunkId: string, emission: number) => {
      const pixels = pngHeader(edge, edge);
      const sourceHash = await sha256Hex(pixels);
      return encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "lamp", type: "Texture", name: "Lamp", engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], parentClass: null,
          payload: { usage: "albedo", compressionState: "compressed", ktx2ChunkId, width: edge, height: edge },
        },
        chunks: [
          { id: "pixels", kind: "pixels", mime: "image/png", data: pixels },
          { id: ktx2ChunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2Header(edge, edge) },
          { id: areaEmissionChunkId(sourceHash), kind: AREA_EMISSION_CHUNK_KIND, mime: "application/x-haptic-area-emission",
            data: await encodeAreaEmission(new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(emission), sourceHash) },
        ],
      });
    };
    await storage.writeBinary(path, await version(4, "ktx2:four", 10));
    expect(await service.registry!.reindexPath(path)).not.toBeNull();
    // A re-import replaces the source, its encode and its prepared emission.
    const reimported = await version(8, "ktx2:eight", 20);
    const saved = saveBeforeChunkRead(service, (chunkId) => chunkId !== "document", async () => {
      await storage.writeBinary(path, reimported);
      await service.registry!.reindexPath(path);
    });
    const loaded = await loadExportDocuments(exportLoaders(service, path));
    expect(saved()).toBe(true);
    const emission = await decodeAreaEmission(loaded.areaEmissionBytesByGuid("lamp")!);
    expect({
      payload: loaded.payloadByGuid("lamp"),
      bytes: loaded.bytesByGuid("lamp"),
      emission: emission.rgba[0],
    }).toEqual({
      payload: expect.objectContaining({ ktx2ChunkId: "ktx2:eight", width: 8, height: 8 }),
      bytes: ktx2Header(8, 8),
      emission: 20,
    });
  });

  it.each([
    ["writes are locked", "Read-only during Simulation Play"],
    ["the write fails", "disk full"],
  ] as const)("fails export only on a Scene whose changed reverb could not be saved because %s", async (cause, reason) => {
    const { storage, service } = await scaffolded();
    const scene = createDefaultScene();
    const unchanged = "assets/Unchanged.scene.hasset";
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    await service.saveDocument("scene", unchanged, scene);
    // Main holds an earlier result; Unchanged already holds the one the bake produces.
    await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([1]), scene as unknown as Record<string, unknown>);
    await service.writeSceneAudioReverbChunk(unchanged, new Uint8Array([2]), scene as unknown as Record<string, unknown>);
    // Wired as AudioReverbBakeProvider wires export's flush.
    const controller = createAudioReverbBakeController({
      bake: async () => new Uint8Array([2]),
      write: async () => { throw new Error("export flushes through withWrite"); },
      withWrite: (work) => service.withSceneWrite((writer) =>
        work((entry) => writer.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload))),
    });
    if (cause === "writes are locked") service.lockAuthoringWrites(reason);
    else vi.spyOn(storage, "writeBinary").mockRejectedValue(new Error(reason));
    const collected = await collectAudioReverbFlushScenes({
      paths: [MAIN_SCENE_FILE, unchanged], load: (path) => service.loadDocument("scene", path),
    });
    const unsaved = await controller.flushAll(collected.scenes);
    const loaded = await loadExportDocuments({
      assets: service.registry!.list().filter((asset) => asset.header.type === "Scene"),
      loadDocument: (_kind, path) => service.loadDocument("scene", path),
      loadDocumentWithChunks: (_kind, path, chunkIds) => service.loadDocumentWithChunks("scene", path, chunkIds),
      readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
      audioReverbBakeFailures: unsaved,
    });
    expect(() => loaded.audioReverbByGuid(service.guidForPath(MAIN_SCENE_FILE)!)).toThrow(reason);
    expect(loaded.audioReverbByGuid(service.guidForPath(unchanged)!)).toEqual(new Uint8Array([2]));
    controller.dispose();
  });

  it.each(["bakes it itself", "joins a background bake of it"] as const)(
    "packs the reverb of the Scene export flushed when a geometry edit starts a background bake while export %s",
    async (start) => {
      const { service } = await scaffolded();
      await service.saveDocument("scene", MAIN_SCENE_FILE, { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
        components: [createMeshComponent("wall-mesh", "box")],
      })] });
      const scene = await service.loadDocument("scene", MAIN_SCENE_FILE) as SerializedScene;
      // The saved chunk is an earlier result for this geometry.
      await service.writeSceneAudioReverbChunk(MAIN_SCENE_FILE, new Uint8Array([1]), scene as unknown as Record<string, unknown>);
      const bakes: Array<(bytes: Uint8Array) => void> = [];
      // Wired as AudioReverbBakeProvider wires background and export bakes.
      const controller = createAudioReverbBakeController({
        debounceMs: 0,
        bake: () => new Promise((resolve) => { bakes.push(resolve); }),
        write: async () => { throw new Error("bakes write through withWrite"); },
        withWrite: (work) => service.withSceneWrite((writer) =>
          work((entry) => writer.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload))),
      });
      const debounced = () => new Promise((resolve) => setTimeout(resolve, 0));
      if (start === "joins a background bake of it") {
        controller.schedule(MAIN_SCENE_FILE, structuredClone(scene) as unknown as Record<string, unknown>);
        await debounced();
      }
      const collected = await collectAudioReverbFlushScenes({
        paths: [MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
      });
      const flushed = controller.flushAll(collected.scenes);
      await vi.waitFor(() => expect(bakes).toHaveLength(1));
      // The user moves the wall in the open tab while export's bake runs.
      const edited = structuredClone(scene);
      edited.actors[0]!.transform.position[0] = 30;
      controller.schedule(MAIN_SCENE_FILE, edited as unknown as Record<string, unknown>);
      await debounced();
      bakes[0]!(new Uint8Array([2]));
      expect((await flushed).size).toBe(0);
      const loaded = await loadExportDocuments({
        assets: service.registry!.list().filter((asset) => asset.header.type === "Scene"),
        loadDocument: (_kind, path) => service.loadDocument("scene", path),
        loadDocumentWithChunks: (_kind, path, chunkIds) => service.loadDocumentWithChunks("scene", path, chunkIds),
        readAssetChunk: (path, chunkId) => service.readAssetChunk(path, chunkId),
        audioReverbBakeFailures: new Map(await flushed),
      });
      expect(loaded.audioReverbByGuid(service.guidForPath(MAIN_SCENE_FILE)!)).toEqual(new Uint8Array([2]));
      // The edit's bake still runs once export's flush has settled.
      await vi.waitFor(() => expect(bakes).toHaveLength(2));
      controller.dispose();
    },
  );

  it.each([
    ["stored in an unsupported format", AssetFormatVersionError],
    ["that is corrupt", Error],
  ] as const)("reports a Scene %s to export instead of baking it", async (state, failure) => {
    const { storage, service } = await scaffolded();
    const scene = createDefaultScene();
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    const unreadable = "assets/Unreadable.scene.hasset";
    await storage.writeBinary(unreadable, state === "that is corrupt" ? new Uint8Array([1, 2, 3]) : await encodeAssetDocument({
      guid: "00000000-0000-4000-8000-0000000000aa", type: "Scene", name: "Unreadable",
      version: SCENE_SCHEMA_VERSION - 1, payload: scene as unknown as Record<string, unknown>,
    }));
    // Export fails on the unreadable Scene only if the game reaches it (loadExportDocuments).
    const collected = await collectAudioReverbFlushScenes({
      paths: [unreadable, MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
    });
    expect(collected.scenes.map((entry) => entry.path)).toEqual([MAIN_SCENE_FILE]);
    expect([...collected.unreadable.keys()]).toEqual([unreadable]);
    expect(collected.unreadable.get(unreadable)).toBeInstanceOf(failure);
  });

  it.each([false, true])("reconciles reverb when manual nav bake saves changed geometry (staged=%s)", async (staged) => {
    const { service } = await scaffolded();
    const scene = { ...createDefaultScene(), actors: [createActor("wall", "Wall", {
      components: [createMeshComponent("wall-mesh", "box")],
    })] };
    await service.saveDocument("scene", MAIN_SCENE_FILE, scene);
    let baked = 0;
    const controller = createAudioReverbBakeController({
      bake: async () => new Uint8Array([++baked]),
      write: (entry) => service.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload),
    });
    await controller.flush(MAIN_SCENE_FILE, scene as unknown as Record<string, unknown>);
    const next = structuredClone(scene);
    next.actors[0]!.transform.position[0] = 20;
    if (staged) await controller.flush(MAIN_SCENE_FILE, next as unknown as Record<string, unknown>);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, new Uint8Array([9]), next as unknown as Record<string, unknown>);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(staged ? new Uint8Array([2]) : null);
    // Export either joins its completed bake or bakes the now-saved geometry.
    await controller.flushAll((await collectAudioReverbFlushScenes({
      paths: [MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
    })).scenes);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([2]));
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(new Uint8Array([9]));
    controller.dispose();
  });

  it.each(["save", "navmesh", "reverb"] as const)("follows a queued rename before a %s write without recreating the old file", async (kind) => {
    const { storage, service } = await scaffolded();
    const path = "assets/Queued.scene.hasset";
    const scene = createDefaultScene();
    await service.saveDocument("scene", path, scene);
    const guid = service.guidForPath(path)!;
    const rename = service.registry!.renameAsset(guid, "Renamed");
    const payload = scene as unknown as Record<string, unknown>;
    const write = kind === "save" ? service.saveDocument("scene", path, scene)
      : kind === "navmesh" ? service.writeSceneNavmeshChunk(path, new Uint8Array([5]), payload)
        : service.writeSceneAudioReverbChunk(path, new Uint8Array([7]), payload);
    const [renamed] = await Promise.all([rename, write]);
    expect(await storage.exists(path)).toBe(false);
    expect(service.registry!.getByGuid(guid)?.path).toBe(renamed.path);
    expect((await decodeAssetDocument(await storage.readBinary(renamed.path))).guid).toBe(guid);
    if (kind !== "save") expect(await service.readAssetChunk(renamed.path, kind === "navmesh" ? NAVMESH_CHUNK_ID : AUDIO_REVERB_CHUNK_ID)).not.toBeNull();
  });

  it("does not recreate an asset deleted ahead of a queued Save", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Deleted.scene.hasset";
    const scene = createDefaultScene();
    await service.saveDocument("scene", path, scene);
    const deletion = service.registry!.deleteAsset(service.guidForPath(path)!);
    const save = service.saveDocument("scene", path, scene);
    await expect(save).rejects.toThrow(/closed or deleted/);
    await deletion;
    expect(await storage.exists(path)).toBe(false);
  });

  it.each(["rename", "delete"] as const)("creates a fresh GUID when a path is reused after %s", async (operation) => {
    const { service } = await scaffolded();
    const path = "assets/Reusable.class.hasset";
    await service.saveDocument("graph", path, { nodes: [], edges: [] });
    await service.loadDocument("graph", path); // Populate the pre-registry path cache.
    const previousGuid = service.guidForPath(path)!;
    const moved = operation === "rename" ? await service.registry!.renameAsset(previousGuid, "Moved") : null;
    if (operation === "delete") await service.registry!.deleteAsset(previousGuid);
    expect(service.guidForPath(path)).toBeNull();
    await service.saveDocument("graph", path, { nodes: [], edges: [] });
    const newGuid = service.guidForPath(path);
    expect(newGuid).not.toBeNull();
    expect(newGuid).not.toBe(previousGuid);
    if (moved) expect(service.registry!.getByGuid(previousGuid)?.path).toBe(moved.path);
    else expect(service.registry!.getByGuid(previousGuid)).toBeUndefined();
  });

  it("uses reindexed on-disk identity instead of a previously loaded path GUID", async () => {
    const { service, storage } = await scaffolded();
    const path = "assets/Replaced.class.hasset";
    await service.saveDocument("graph", path, { nodes: [], edges: [] });
    await service.loadDocument("graph", path);
    const replacement = await decodeAssetDocument(await storage.readBinary(path));
    replacement.guid = "replaced-guid";
    await storage.writeBinary(path, await encodeAssetDocument(replacement));
    await service.registry!.reindexPath(path);
    expect(service.guidForPath(path)).toBe("replaced-guid");
    await service.saveDocument("graph", path, { nodes: [], edges: [], properties: { edited: true } });
    expect((await decodeAssetDocument(await storage.readBinary(path))).guid).toBe("replaced-guid");
  });

  it("writes a Scene audioReverb extra chunk and keeps navmesh", async () => {
    const { service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    await service.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      new Uint8Array([1, 2]),
      scene as unknown as Record<string, unknown>,
    );
    const field = new Uint8Array([9, 8, 7]);
    await service.writeSceneAudioReverbChunk(
      MAIN_SCENE_FILE,
      field,
      scene as unknown as Record<string, unknown>,
    );
    expect(
      await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID),
    ).toEqual(field);
    expect(
      await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID),
    ).toEqual(new Uint8Array([1, 2]));
  });

  it("indexes FunctionLibrary function members on the Class header", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/MathLib.class.hasset";
    await storage.writeBinary(
      path,
      await encodeAssetDocument(
        {
          type: "Class",
          name: "MathLib",
          guid: "math-lib-guid",
          version: 1,
          payload: { nodes: [], edges: [], members: [] },
        },
        { parentClass: "FunctionLibrary" },
      ),
    );
    await service.remountRegistry();
    await service.saveDocument("graph", path, {
      nodes: [],
      edges: [],
      members: [
        {
          id: "fn-1",
          kind: "function",
          name: "Add",
          pins: [
            { name: "exec", typeId: "exec", direction: "in" },
            { name: "a", typeId: "float", direction: "in" },
            { name: "then", typeId: "exec", direction: "out" },
          ],
        },
        { id: "var-1", kind: "variable", name: "X", typeId: "float" },
      ],
    });
    const header = readAssetDocumentHeader(await storage.readBinary(path));
    expect(header.payload.functions).toEqual([
      {
        id: "fn-1",
        name: "Add",
        pins: [
          { name: "exec", typeId: "exec", direction: "in" },
          { name: "a", typeId: "float", direction: "in" },
          { name: "then", typeId: "exec", direction: "out" },
        ],
      },
    ]);
    expect(header.payload.variables).toEqual([
      { id: "var-1", name: "X", typeId: "float" },
    ]);
    expect(header.payload.events).toEqual([]);
  });

  it("indexes Actor Class members including typeClassId on the header", async () => {
    const { storage, service } = await scaffolded();
    await service.saveDocument("graph", MAIN_CLASS_FILE, {
      nodes: [],
      edges: [],
      members: [
        {
          id: "fn-1",
          kind: "function",
          name: "Jump",
          pins: [
            {
              name: "pawn",
              typeId: "object",
              direction: "in",
              typeClassId: "Pawn",
            },
          ],
        },
        {
          id: "var-1",
          kind: "variable",
          name: "Target",
          typeId: "object",
          typeClassId: "Hero",
        },
        {
          id: "ev-1",
          kind: "event",
          name: "On Hit",
          pins: [
            {
              name: "other",
              typeId: "object",
              direction: "out",
              typeClassId: "Actor",
            },
          ],
        },
      ],
    });
    const header = readAssetDocumentHeader(
      await storage.readBinary(MAIN_CLASS_FILE),
    );
    expect(header.payload.functions).toEqual([
      {
        id: "fn-1",
        name: "Jump",
        pins: [
          {
            name: "pawn",
            typeId: "object",
            direction: "in",
            typeClassId: "Pawn",
          },
        ],
      },
    ]);
    expect(header.payload.variables).toEqual([
      {
        id: "var-1",
        name: "Target",
        typeId: "object",
        typeClassId: "Hero",
      },
    ]);
    expect(header.payload.events).toEqual([
      {
        id: "ev-1",
        name: "On Hit",
        pins: [
          {
            name: "other",
            typeId: "object",
            direction: "out",
            typeClassId: "Actor",
          },
        ],
      },
    ]);
  });

  /** An imported Audio asset with one `source` clip, indexed by the registry. */
  async function audioAsset(service: ProjectService, storage: MemoryStorageAdapter, path: string, source: Uint8Array) {
    await storage.writeBinary(
      path,
      await encodeHasset({
        header: {
          dependencyMetadataVersion: 1, requiredDependencies: [],
          guid: "audio-guid",
          type: "Audio",
          name: "Jump",
          engineVersion: "0.0.0",
          version: 1,
          mode: "thin",
          dependencies: [],
          parentClass: null,
          payload: {},
        },
        chunks: [
          { id: "source", kind: "audio", mime: "audio/wav", data: source },
        ],
      }),
    );
    await service.remountRegistry();
  }

  it("writes extra Audio clip chunks and refuses to delete source", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Jump.hasset";
    const source = new Uint8Array([1, 2, 3, 4]);
    await audioAsset(service, storage, path, source);
    const extra = new Uint8Array([9, 8, 7]);
    await service.writeAudioClipChunk(path, "source:2", extra, "audio/ogg", {
      clips: [
        { chunkId: "source", weight: 1 },
        { chunkId: "source:2", weight: 1 },
      ],
    });
    expect(await service.readAssetChunk(path, "source")).toEqual(source);
    expect(await service.readAssetChunk(path, "source:2")).toEqual(extra);
    await service.removeAudioClipChunk(path, "source", {
      clips: [{ chunkId: "source", weight: 1 }],
    });
    expect(await service.readAssetChunk(path, "source")).toEqual(source);
    await service.removeAudioClipChunk(path, "source:2", {
      clips: [{ chunkId: "source", weight: 1 }],
    });
    expect(await service.readAssetChunk(path, "source:2")).toBeNull();
    expect(await service.readAssetChunk(path, "source")).toEqual(source);
  });

  it("follows a queued rename before an Audio clip write without recreating the old file", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Jump.hasset";
    await audioAsset(service, storage, path, new Uint8Array([1, 2]));
    const rename = service.registry!.renameAsset("audio-guid", "Leap");
    const write = service.writeAudioClipChunk(path, "source:2", new Uint8Array([9]), "audio/ogg", {
      clips: [{ chunkId: "source", weight: 1 }, { chunkId: "source:2", weight: 1 }],
    });
    const [renamed] = await Promise.all([rename, write]);
    expect(await storage.exists(path)).toBe(false);
    expect(await service.readAssetChunk(renamed.path, "source:2")).toEqual(new Uint8Array([9]));
  });

  it("rewrites remaining sprites to None after a referenced texture is deleted", async () => {
    const { storage, service } = await scaffolded();
    const texPath = "assets/wall.hasset";
    const spritePath = "assets/hero.sprite.hasset";
    await storage.writeBinary(
      texPath,
      await encodeAssetDocument({
        type: "Texture",
        name: "wall",
        guid: "tex-1",
        version: 1,
        payload: { usage: "albedo" },
      }),
    );
    await storage.writeBinary(
      spritePath,
      await encodeAssetDocument(
        {
          type: "Sprite",
          name: "hero",
          guid: "sprite-1",
          version: 1,
          payload: {
            textureGuid: "tex-1",
            pixelsPerUnit: 100,
            frames: [],
            clips: [],
          },
        },
        { dependencies: ["tex-1"] },
      ),
    );
    await service.remountRegistry();
    await service.registry!.deleteAsset("tex-1");
    const dangling = (await service.loadDocument("sprite", spritePath)) as {
      textureGuid: string | null;
    };
    expect(dangling.textureGuid).toBe("tex-1");

    let releaseProgress!: () => void;
    const progressPause = new Promise<void>((resolve) => { releaseProgress = resolve; });
    const progress = vi.fn(() => progressPause);
    const repair = service.clearDeletedAssetReferences(new Set(["tex-1"]), {
      onProgress: progress,
    });
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    expect((await service.loadDocument("sprite", spritePath) as { textureGuid: string | null }).textureGuid).toBe("tex-1");
    releaseProgress();
    await repair;
    expect(progress).toHaveBeenCalledWith(spritePath);

    const cleared = (await service.loadDocument("sprite", spritePath)) as {
      textureGuid: string | null;
    };
    expect(cleared.textureGuid).toBeNull();
    expect(
      readAssetDocumentHeader(await storage.readBinary(spritePath))
        .dependencies,
    ).toEqual([]);
  });

  it("reports a referrer it could not rewrite and still repairs the others", async () => {
    const { storage, service } = await scaffolded();
    await storage.writeBinary("assets/wall.hasset", await encodeAssetDocument({
      type: "Texture", name: "wall", guid: "tex-1", version: 1, payload: { usage: "albedo" },
    }));
    const sprite = (name: string) => encodeAssetDocument(
      { type: "Sprite", name, guid: `${name}-1`, version: 1, payload: { textureGuid: "tex-1", pixelsPerUnit: 100, frames: [], clips: [] } },
      { dependencies: ["tex-1"] },
    );
    await storage.writeBinary("assets/stuck.sprite.hasset", await sprite("stuck"));
    await storage.writeBinary("assets/hero.sprite.hasset", await sprite("hero"));
    await service.remountRegistry();
    await service.registry!.deleteAsset("tex-1");
    const write = storage.writeBinary.bind(storage);
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path.startsWith("assets/stuck")) throw new Error("Disk full");
      return write(path, bytes);
    });

    const failed = await service.clearDeletedAssetReferences(new Set(["tex-1"]));
    expect(failed.map((entry) => [entry.path, String(entry.error)])).toEqual([
      ["assets/stuck.sprite.hasset", "Error: Disk full"],
    ]);
    expect((await service.loadDocument("sprite", "assets/hero.sprite.hasset") as { textureGuid: string | null }).textureGuid).toBeNull();
    expect((await service.loadDocument("sprite", "assets/stuck.sprite.hasset") as { textureGuid: string | null }).textureGuid).toBe("tex-1");
  });

  it("repairs referrers one at a time in catalog order while reading their documents ahead, and skips one it cannot read", async () => {
    const { storage, service } = await scaffolded();
    await storage.writeBinary("assets/wall.hasset", await encodeAssetDocument({
      type: "Texture", name: "wall", guid: "tex-1", version: 1, payload: { usage: "albedo" },
    }));
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    for (const name of names) {
      await storage.writeBinary(`assets/${name}.sprite.hasset`, await encodeAssetDocument(
        { type: "Sprite", name, guid: `${name}-1`, version: 1, payload: { textureGuid: "tex-1", pixelsPerUnit: 100, frames: [], clips: [] } },
        { dependencies: ["tex-1"] },
      ));
    }
    await service.remountRegistry();
    await service.registry!.deleteAsset("tex-1");
    const catalog = service.registry!.list().map((asset) => asset.path).filter((path) => path.endsWith(".sprite.hasset"));
    expect(catalog).toHaveLength(names.length);
    // A file that became unreadable after it was catalogued is skipped, as it always was.
    const unreadable = catalog[2]!;
    const garbage = new Uint8Array([1, 2, 3]);
    await storage.writeBinary(unreadable, garbage);
    // The first referrer answers last, so a repair that saved in completion order would not follow the catalog.
    const read = storage.readBinaryRange.bind(storage);
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, ...rest) => {
      const sprite = path.endsWith(".sprite.hasset");
      if (sprite) peak = Math.max(peak, ++inFlight);
      try {
        if (sprite) await new Promise((resolve) => setTimeout(resolve, path === catalog[0] ? 40 : 2));
        return await read(path, ...rest);
      } finally { if (sprite) inFlight--; }
    });
    const write = storage.writeBinary.bind(storage);
    const saved: string[] = [];
    vi.spyOn(storage, "writeBinary").mockImplementation(async (path, bytes) => {
      if (path.endsWith(".sprite.hasset")) saved.push(path);
      return write(path, bytes);
    });

    const failed = await service.clearDeletedAssetReferences(new Set(["tex-1"]));

    expect(failed).toEqual([]);
    expect(saved).toEqual(catalog.filter((path) => path !== unreadable));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    for (const path of catalog) {
      if (path === unreadable) expect(await storage.readBinary(path)).toEqual(garbage);
      else expect((await service.loadDocument("sprite", path) as { textureGuid: string | null }).textureGuid).toBeNull();
    }
  });

  it("reads a document again before giving up on it when the read that ran ahead failed", async () => {
    const { storage, service } = await scaffolded();
    await storage.writeBinary("assets/wall.hasset", await encodeAssetDocument({
      type: "Texture", name: "wall", guid: "tex-1", version: 1, payload: { usage: "albedo" },
    }));
    const names = ["a", "b", "c"];
    const paths = names.map((name) => `assets/${name}.sprite.hasset`);
    for (const [index, path] of paths.entries()) {
      await storage.writeBinary(path, await encodeAssetDocument(
        { type: "Sprite", name: names[index]!, guid: `${names[index]}-1`, version: 1, payload: { textureGuid: "tex-1", pixelsPerUnit: 100, frames: [], clips: [] } },
        { dependencies: ["tex-1"] },
      ));
    }
    await service.remountRegistry();
    await service.registry!.deleteAsset("tex-1");
    // The first read of "b" fails, as one does when a plugin root is unmounted for a moment while it is in flight.
    const read = storage.readBinaryRange.bind(storage);
    let failedOnce = false;
    vi.spyOn(storage, "readBinaryRange").mockImplementation(async (path, ...rest) => {
      if (path === paths[1] && !failedOnce) { failedOnce = true; throw new Error("Content root is remounting"); }
      return read(path, ...rest);
    });

    const failed = await service.clearDeletedAssetReferences(new Set(["tex-1"]));

    expect(failedOnce).toBe(true);
    expect(failed).toEqual([]);
    for (const path of paths) {
      expect((await service.loadDocument("sprite", path) as { textureGuid: string | null }).textureGuid).toBeNull();
    }
  });

  it("repairs a reference stored in a field the header dependency metadata does not describe", async () => {
    const { storage, service } = await scaffolded();
    await storage.writeBinary("assets/wall.hasset", await encodeAssetDocument({
      type: "Texture", name: "wall", guid: "tex-1", version: 1, payload: { usage: "albedo" },
    }));
    // The dependency scan reads typed fields only, so this reference leaves the header's
    // dependency list empty. Delete repair must still find it by walking the document.
    await storage.writeBinary("assets/hero.sprite.hasset", await encodeAssetDocument({
      type: "Sprite", name: "hero", guid: "sprite-1", version: 1,
      payload: { pixelsPerUnit: 100, frames: [], clips: [], notes: { favourite: "tex-1" } },
    }));
    await service.remountRegistry();
    expect(service.registry!.getByGuid("sprite-1")!.header.dependencies).toEqual([]);
    await service.registry!.deleteAsset("tex-1");

    await service.clearDeletedAssetReferences(new Set(["tex-1"]));

    expect((await service.loadDocument("sprite", "assets/hero.sprite.hasset") as { notes: { favourite: string | null } }).notes.favourite).toBeNull();
  });

  it("resets a Class parentClass to BObject when the parent Class is deleted", async () => {
    const { storage, service } = await scaffolded();
    const parentPath = "assets/Hero.class.hasset";
    const childPath = "assets/Sidekick.class.hasset";
    const graph = createDefaultLogicGraphSerialized();
    await storage.writeBinary(
      parentPath,
      await encodeAssetDocument(
        {
          type: "Class",
          name: "Hero",
          guid: "hero-1",
          version: 1,
          payload: graph as unknown as Record<string, unknown>,
        },
        { parentClass: "Actor" },
      ),
    );
    await storage.writeBinary(
      childPath,
      await encodeAssetDocument(
        {
          type: "Class",
          name: "Sidekick",
          guid: "side-1",
          version: 1,
          payload: graph as unknown as Record<string, unknown>,
        },
        { parentClass: "Hero" },
      ),
    );
    await service.remountRegistry();
    await service.registry!.deleteAsset("hero-1");
    await service.clearDeletedAssetReferences(new Set(["hero-1"]), {
      deletedClassNames: new Set(["Hero"]),
    });
    expect(
      readAssetDocumentHeader(await storage.readBinary(childPath)).parentClass,
    ).toBe("BObject");
  });

  it("clears a dirty open referrer in memory and on disk without dropping dirty", async () => {
    const { storage, service } = await scaffolded();
    const texPath = "assets/wall.hasset";
    const spritePath = "assets/hero.sprite.hasset";
    await storage.writeBinary(
      texPath,
      await encodeAssetDocument({
        type: "Texture",
        name: "wall",
        guid: "tex-1",
        version: 1,
        payload: { usage: "albedo" },
      }),
    );
    await storage.writeBinary(
      spritePath,
      await encodeAssetDocument(
        {
          type: "Sprite",
          name: "hero",
          guid: "sprite-1",
          version: 1,
          payload: {
            textureGuid: "tex-1",
            pixelsPerUnit: 100,
            frames: [{ name: "idle" }],
            clips: [],
          },
        },
        { dependencies: ["tex-1"] },
      ),
    );
    await service.remountRegistry();
    const docs = new DocumentService();
    docs.ensureContentBrowserTab();
    await docs.openDocument(service, {
      kind: "sprite",
      path: spritePath,
      label: "hero",
    });
    const spriteId = documentId({ kind: "sprite", path: spritePath });
    docs.updateAssetDocument(spriteId, {
      textureGuid: "tex-1",
      pixelsPerUnit: 50,
      frames: [{ name: "idle" }],
      clips: [],
    });
    expect(docs.getDocument(spriteId)?.dirty).toBe(true);

    await service.registry!.deleteAsset("tex-1");
    await service.clearDeletedAssetReferences(new Set(["tex-1"]));
    const disk = (await service.loadDocument("sprite", spritePath)) as {
      textureGuid: string | null;
    };
    expect(disk.textureGuid).toBeNull();

    const walked = clearDeletedAssetRefs(
      docs.getDocument(spriteId)!.content,
      new Set(["tex-1"]),
    );
    docs.patchLoadedContent(spriteId, walked.value as Record<string, unknown>);
    const open = docs.getDocument(spriteId);
    expect(open?.dirty).toBe(true);
    expect(
      (open?.content as { textureGuid: string | null }).textureGuid,
    ).toBeNull();
    expect((open?.content as { pixelsPerUnit: number }).pixelsPerUnit).toBe(50);
  });

  it("loads a Trace document from derived storage and refuses to save it", async () => {
    const { service } = await scaffolded();
    const derived = new MemoryStorageAdapter("documents");
    await derived.openDocumentsProject("derived-traces");
    service.setDerivedStorage(derived);
    const guid = service.guid;
    expect(guid).toBeTruthy();
    const path = await writeTraceDocument(derived, guid!, "session-1", {
      name: "session-1",
      guid: "trace-guid",
      payload: { seed: 8, dt: 1 / 60, frames: [] },
    });
    const loaded = (await service.loadDocument("trace", path)) as {
      seed: number;
      frames: unknown[];
    };
    expect(loaded.seed).toBe(8);
    expect(loaded.frames).toEqual([]);
    await expect(service.saveDocument("trace", path, loaded)).rejects.toThrow(
      /read-only/i,
    );
  });
});

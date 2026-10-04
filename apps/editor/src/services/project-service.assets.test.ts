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
  type SerializedScene,
} from "@babylonslate/core";
import {
  decodeAssetDocument,
  decodeBabasset,
  encodeAssetDocument,
  encodeBabasset,
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
  type EncodeFn,
} from "@babylonslate/assets";
import { AUDIO_REVERB_CHUNK_ID } from "@babylonslate/assets";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";
import { DocumentService } from "./document-service";
import { createDefaultLogicGraphSerialized } from "./graph-validation";
import { MANNEQUIN_CLASS_FILE } from "../lib/scaffold-empty-3d";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { collectAudioReverbFlushScenes, createAudioReverbBakeController } from "../lib/audio-reverb-bake";

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
  await storage.writeBinary(path, await encodeBabasset({
    header: {
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
  await storage.openDocumentsProject("Assets.babproject");
  if (!authentic) await installMinimalProject(storage);
  const service = new ProjectService(storage);
  const loaded = await service.loadCurrentProject();
  return { storage, service, loaded };
}

describe("project documents as .babasset", () => {
  it.each(["read", "decode"])("rejects a Class %s failure instead of opening an empty graph", async (failure) => {
    const { service, storage } = await scaffolded();
    const path = "assets/Unreadable.class.babasset";
    await service.saveDocument("graph", path, { nodes: [], edges: [], properties: { label: "Keep me" } });
    if (failure === "decode") await storage.writeBinary(path, new Uint8Array([1, 2, 3]));
    const bytes = await storage.readBinary(path);
    const read = storage.readBinary.bind(storage);
    const readSpy = vi.spyOn(storage, "readBinary").mockImplementation(async (requested) => {
      if (failure === "read" && requested === path) throw new Error("Storage temporarily unavailable");
      return read(requested);
    });
    const documents = new DocumentService();
    await expect(documents.openDocument(service, { kind: "graph", path, label: "Unreadable" })).rejects.toThrow();
    expect(documents.getDocument(documentId({ kind: "graph", path }))).toBeUndefined();
    readSpy.mockRestore();
    expect(await storage.readBinary(path)).toEqual(bytes);
  });

  it.each([false, true])("persists one Class replacement across all usages (None=%s)", async (none) => {
    const { service, storage } = await scaffolded();
    const sourcePath = "assets/Hero.class.babasset";
    const replacementPath = "assets/NPC.class.babasset";
    const childPath = "assets/Child.class.babasset";
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
    const sourcePath = "assets/Hero.class.babasset";
    const childPath = "assets/Child.class.babasset";
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
    const sourcePath = "assets/Hero.class.babasset";
    const childPath = "assets/Child.class.babasset";
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

  it("refuses to save unnamed or duplicate material parameters and keeps the saved asset intact", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Named.material.babasset";
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
    const classPath = "assets/My Hero.class.babasset";
    const matPath = "assets/Assigned.material.babasset";
    const replacementPath = "assets/Replacement.material.babasset";
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
      "assets/Unassigned.material.babasset",
      {},
    );
    const guid = service.guidForPath("assets/Unassigned.material.babasset")!;
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

  it("still reads projects whose documents are legacy JSON", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Legacy.babproject");
    await storage.mkdir("scenes", true);
    await storage.writeText(
      "scenes/main.scene.json",
      JSON.stringify({ name: "Legacy", meshes: [], version: 1 }),
    );
    const service = new ProjectService(storage);

    const scene = (await service.loadDocument(
      "scene",
      "scenes/main.scene.json",
    )) as SerializedScene;
    expect(scene.name).toBe("Legacy");

    // The legacy payload is a schema version behind, so saving it back needs
    // the same explicit migrate-on-save approval as any other stale asset.
    service.approveMigrateOnSave();
    await service.saveDocument("scene", "scenes/main.scene.json", scene);
    expect(
      JSON.parse(await storage.readText("scenes/main.scene.json")).version,
    ).toBe(4);
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

    expect(await storage.exists("assets/Mannequin.class.babasset")).toBe(true);
    expect(await storage.exists("assets/main.class.babasset")).toBe(false);
    expect(
      await storage.exists("assets/Mannequin/Mannequin.anim.babasset"),
    ).toBe(true);
    const classHeader = readAssetDocumentHeader(
      await storage.readBinary("assets/Mannequin.class.babasset"),
    );
    expect(classHeader.type).toBe("Class");
    expect(classHeader.parentClass).toBe("Actor");
    expect(classHeader.name).toBe("Mannequin");

    const graphDoc = await decodeAssetDocument(
      await storage.readBinary("assets/Mannequin/Mannequin.anim.babasset"),
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
    const path = "assets/Ui.babasset";
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
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
    const saved = await decodeBabasset(await storage.readBinary(path));
    expect(saved.chunks.get("source")).toEqual(source);
    const reloaded = (await service.loadDocument("font", path)) as Record<
      string,
      unknown
    >;
    expect(reloaded.family).toBe("Ui Display");
  });

  it("rewrites legacy Graph assets to Class on save", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/legacy.graph.babasset";
    await storage.writeBinary(
      path,
      await encodeAssetDocument({
        type: "Graph",
        name: "legacy",
        guid: "graph-guid",
        version: 1,
        payload: { nodes: [], edges: [] },
      }),
    );
    const loaded = await service.loadDocument("graph", path);
    service.approveMigrateOnSave();
    await service.saveDocument("graph", path, loaded);
    const header = readAssetDocumentHeader(await storage.readBinary(path));
    expect(header.type).toBe("Class");
    expect(header.parentClass).toBe("Actor");
  });

  it("saves Texture settings onto the header without dropping pixel chunks", async () => {
    const { storage, service } = await scaffolded();
    const pixels = new Uint8Array([9, 8, 7, 6]);
    const path = "assets/hero.babasset";
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
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
      "asset-settings",
      path,
    )) as Record<string, unknown>;
    expect(payload.usage).toBe("albedo");
    await service.saveDocument("asset-settings", path, {
      ...payload,
      usage: "pixelArt",
    });

    const saved = await decodeBabasset(await storage.readBinary(path));
    expect(saved.header.type).toBe("Texture");
    expect(saved.header.payload.usage).toBe("pixelArt");
    expect(saved.chunks.get("pixels")).toEqual(pixels);
    expect(saved.header.chunks.some((chunk) => chunk.id === "document")).toBe(
      false,
    );
  });

  it("keeps an encode committed while the Texture was open when saving it", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/spark.babasset";
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
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

    const saved = await decodeBabasset(await storage.readBinary(path));
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

  it("keeps a Tileset's texture at its own size, even when picked mid-encode, and pads it again once no atlas uses it", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Atlas.babproject");
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
    const tilesetPath = "assets/Ground.tileset.babasset";
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
    await storage.openDocumentsProject("Unsaved.babproject");
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
    await service.saveDocument("tileset", "assets/Ground.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: guid });
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 1, 1, undefined]));
    const opened = (await service.loadDocument("texture", texture!.path)) as Record<string, unknown>;

    // Details sets Usage to Particle without saving: Particle pads even an atlas.
    tabUsages.set(guid, "particle");
    await service.retryTextureEncoding(guid, { force: true, usage: "particle" });
    await vi.waitFor(() => expect(encoded()).toEqual(["compressed", 4, 4, 4]));
    const particleChunkId = payload().ktx2ChunkId;

    // A Content Browser change or foreground rescan remounts the registry, which runs the pass.
    const runs = service.textureAlignmentState.runs;
    await service.remountRegistry();
    await vi.waitFor(() => {
      const state = service.textureAlignmentState;
      expect(state.runs).toBeGreaterThan(runs);
      expect(state.pending).toBe(0);
    });
    expect(encoded()).toEqual(["compressed", 4, 4, 4]);
    expect(payload().ktx2ChunkId).toBe(particleChunkId);

    await service.saveDocument("texture", texture!.path, { ...opened, usage: "particle" });
    const saved = await decodeBabasset(await storage.readBinary(texture!.path));
    expect(saved.header.payload).toMatchObject({ usage: "particle", ktx2ChunkId: particleChunkId, ktx2BlockAlign: 4 });
  });

  it("re-encodes an old odd Texture on the grid when a project with source control off opens", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Solo.babproject");
    await installMinimalProject(storage);
    await writeLegacyOddTexture(storage, "assets/odd.babasset", "odd");
    const service = new ProjectService(storage, { encode: standInEncode });

    await service.loadCurrentProject();
    await vi.waitFor(() =>
      expect(service.registry!.getByGuid("odd")!.header.payload).toMatchObject({
        compressionState: "compressed",
        ktx2ChunkId: KTX2_KEY_MAX_1,
        ktx2Width: 4,
        ktx2Height: 4,
      }),
    );
  });

  it("with source control on, re-encodes an old odd Texture only when the user retries it, or once source control is turned off", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("SharedOdd.babproject");
    await installMinimalProject(storage);
    await enableSourceControlOnDisk(storage);
    await writeLegacyOddTexture(storage, "assets/retried.babasset", "retried");
    await writeLegacyOddTexture(storage, "assets/waiting.babasset", "waiting");
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });
    const payload = (guid: string) => service.registry!.getByGuid(guid)!.header.payload;

    await service.loadCurrentProject();
    // Each call runs after the passes queued before it (the open's, the remount's).
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

    // Turning source control off in Project Settings runs the pass.
    service.setSourceControlEnabled(false);
    await vi.waitFor(() => expect(payload("waiting")).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 }));
    expect(encode).toHaveBeenCalledTimes(2);
    expect(await service.textureAlignmentStale("waiting")).toBe(false);
  });

  it("with source control on, keeps a Tileset's texture at its own size only when this session padded it or created its file", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Shared.babproject");
    await installMinimalProject(storage);
    await enableSourceControlOnDisk(storage);
    // Padded by an earlier session: a teammate may be changing it.
    const legacyPath = "assets/legacy-padded.babasset";
    await storage.writeBinary(legacyPath, await encodeBabasset({
      header: {
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
    // New files carrying the earlier session's padded encode: a Duplicate and a .babasset import.
    const copy = await registry.duplicateAsset("legacy-padded", "project");
    const [imported] = await registry.importFile("project", "incoming", "incoming.babasset", await storage.readBinary(legacyPath));
    expect(imported!.header.guid).not.toBe("legacy-padded");
    for (const created of [copy, imported!]) expect(encoded(created.header.guid)).toEqual(["compressed", 4, 4, 4]);

    await service.saveDocument("tileset", "assets/Old.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: "legacy-padded" });
    await service.saveDocument("tileset", "assets/New.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: texture!.header.guid });
    await service.saveDocument("tileset", "assets/Copy.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: copy.header.guid });
    await service.saveDocument("tileset", "assets/Imported.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: imported!.header.guid });
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
    await storage.openDocumentsProject("Reverted.babproject");
    await installMinimalProject(storage);
    const path = "assets/odd.babasset";
    await writeLegacyOddTexture(storage, path, "odd");
    const committedInGit = await storage.readBinary(path);
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });
    const payload = () => service.registry!.getByGuid("odd")!.header.payload;

    // Source control is off: opening the project re-encodes it on the grid.
    await service.loadCurrentProject();
    await vi.waitFor(() => expect(payload()).toMatchObject({ compressionState: "compressed", ktx2Width: 4, ktx2Height: 4 }));
    // Project Settings turns source control on, and a git client restores the committed file.
    service.setSourceControlEnabled(true);
    await nextMillisecond();
    await storage.writeBinary(path, committedInGit);

    // Returning to the app remounts the registry, which runs the pass.
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
    await storage.openDocumentsProject("RevertedQueued.babproject");
    await installMinimalProject(storage);
    const path = "assets/odd.babasset";
    await writeLegacyOddTexture(storage, path, "odd");
    const committedInGit = await storage.readBinary(path);
    const encode = vi.fn(standInEncode);
    const service = new ProjectService(storage, { encode });

    // Source control is off: opening the project pads it on the grid.
    await service.loadCurrentProject();
    await vi.waitFor(() => expect(service.registry!.getByGuid("odd")!.header.payload).toMatchObject({ ktx2Width: 4, ktx2BlockAlign: 4 }));
    service.setSourceControlEnabled(true);
    // A Tileset picks it while the queue is paused: the padding is this
    // session's own, so a re-encode at its own size is queued.
    service.pauseTextureEncodeQueue();
    await service.saveDocument("tileset", "assets/Ground.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: "odd" });
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
    await storage.openDocumentsProject("InFlight.babproject");
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
    await service.saveDocument("tileset", "assets/Ground.tileset.babasset", { ...createDefaultTilesetPayload(), textureGuid: guid });
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
    await storage.openDocumentsProject("Rescan.babproject");
    await installMinimalProject(storage);
    const paths = Array.from({ length: 8 }, (_, index) => `assets/odd-${index}.babasset`);
    for (const [index, path] of paths.entries()) await writeLegacyOddTexture(storage, path, `odd-${index}`);
    // Opened with source control on, so the pass waits until it is turned off below.
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
    await storage.openDocumentsProject("TurnedOn.babproject");
    await installMinimalProject(storage);
    const paths = ["assets/odd-a.babasset", "assets/odd-b.babasset"];
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
    const onDisk = async (path: string) => (await decodeBabasset(await storage.readBinary(path))).header.payload;

    // Source control is off: opening the project queues both re-encodes.
    await service.loadCurrentProject();
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
    await storage.openDocumentsProject("TurnedOnDetails.babproject");
    await installMinimalProject(storage);
    for (const guid of ["odd-0", "odd-1"]) await writeLegacyOddTexture(storage, `assets/${guid}.babasset`, guid);
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

    // Source control is off: opening the project queues both re-encodes, so no Retry Encoding.
    await service.loadCurrentProject();
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

  it("encodes each Texture once however often the registry remounts while its encode waits or runs", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Backlog.babproject");
    await installMinimalProject(storage);
    const paths = ["assets/odd-a.babasset", "assets/odd-b.babasset"];
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

    // The page is hidden: the open's alignment re-encodes and an import wait in the queue.
    service.pauseTextureEncodeQueue();
    await service.loadCurrentProject();
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

  it("decodes an unchanged legacy Tileset once across remounts, and again once it changes", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Legacy.babproject");
    await installMinimalProject(storage);
    const tilesetPath = "assets/ground.tileset.babasset";
    // Saved before atlas meta existed: only its document names the texture.
    const writeLegacyTileset = async (textureGuid: string) => storage.writeBinary(tilesetPath, await encodeAssetDocument({
      guid: "ground", type: "Tileset", name: "Ground", version: 1,
      payload: { ...createDefaultTilesetPayload(), textureGuid } as unknown as Record<string, unknown>,
    }, { dependencies: [textureGuid] }));
    await writeLegacyTileset("tex-a");
    const service = new ProjectService(storage);
    await service.loadCurrentProject();
    expect(service.registry!.isAtlasTexture("tex-a")).toBe(true);
    const reads = vi.spyOn(storage, "readBinary");
    const tilesetReads = () => reads.mock.calls.filter(([path]) => path === tilesetPath).length;

    await service.remountRegistry();
    // The header scan only: the decoded referrer is remembered.
    expect(tilesetReads()).toBe(1);
    expect(service.registry!.isAtlasTexture("tex-a")).toBe(true);

    // Another checkout of the Tileset, still without meta, picks another texture.
    await writeLegacyTileset("tex-b");
    reads.mockClear();
    await service.remountRegistry();
    expect(tilesetReads()).toBe(2);
    expect(service.registry!.isAtlasTexture("tex-a")).toBe(false);
    expect(service.registry!.isAtlasTexture("tex-b")).toBe(true);
  });

  it("saves Model slots onto the header without replacing the source GLB", async () => {
    const { storage, service } = await scaffolded();
    const source = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]);
    const path = "assets/hero.babasset";
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
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

    const saved = await decodeBabasset(await storage.readBinary(path));
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
    const decoded = await decodeBabasset(await storage.readBinary(MAIN_SCENE_FILE));
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
    const decoded = await decodeBabasset(bytes);
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
    await controller.flushAll(persisted);
    const saved = await decodeAssetDocument(await storage.readBinary(MAIN_SCENE_FILE));
    expect((saved.payload as unknown as SerializedScene).actors[0]!.transform.position[0]).toBe(0);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([2]));
    controller.dispose();
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
    await controller.flushAll(await collectAudioReverbFlushScenes({
      paths: [MAIN_SCENE_FILE], load: (path) => service.loadDocument("scene", path),
    }));
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(new Uint8Array([2]));
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(new Uint8Array([9]));
    controller.dispose();
  });

  it.each(["save", "navmesh", "reverb"] as const)("follows a queued rename before a %s write without recreating the old file", async (kind) => {
    const { storage, service } = await scaffolded();
    const path = "assets/Queued.scene.babasset";
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
    const path = "assets/Deleted.scene.babasset";
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
    const path = "assets/Reusable.class.babasset";
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
    const path = "assets/Replaced.class.babasset";
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
    const path = "assets/MathLib.class.babasset";
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

  it("writes extra Audio clip chunks and refuses to delete source", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/Jump.babasset";
    const source = new Uint8Array([1, 2, 3, 4]);
    await storage.writeBinary(
      path,
      await encodeBabasset({
        header: {
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

  it("rewrites remaining sprites to None after a referenced texture is deleted", async () => {
    const { storage, service } = await scaffolded();
    const texPath = "assets/wall.babasset";
    const spritePath = "assets/hero.sprite.babasset";
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

  it("resets a Class parentClass to BObject when the parent Class is deleted", async () => {
    const { storage, service } = await scaffolded();
    const parentPath = "assets/Hero.class.babasset";
    const childPath = "assets/Sidekick.class.babasset";
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
    const texPath = "assets/wall.babasset";
    const spritePath = "assets/hero.sprite.babasset";
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

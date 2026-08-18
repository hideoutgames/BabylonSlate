import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
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
} from "@babylonslate/assets";
import { AUDIO_REVERB_CHUNK_ID } from "@babylonslate/assets";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";
import { createDefaultLogicGraphSerialized } from "./graph-validation";

async function scaffolded() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Assets.babproject");
  const service = new ProjectService(storage);
  const loaded = await service.loadCurrentProject();
  return { storage, service, loaded };
}

describe("project documents as .babasset", () => {
  it("scaffolds scene and graph assets under assets/", async () => {
    const { storage, loaded } = await scaffolded();
    expect(loaded.document.scenes).toEqual([MAIN_SCENE_FILE]);
    expect(await storage.exists(MAIN_SCENE_FILE)).toBe(true);
    expect(await storage.exists(MAIN_CLASS_FILE)).toBe(true);
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
    expect(header.version).toBe(3);
    expect(header.guid).toBeTruthy();
    expect(header.chunks[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips scene and graph content through the codec", async () => {
    const { storage, service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const graph = await service.loadDocument("graph", MAIN_CLASS_FILE);
    expect(scene.actors.find((actor) => actor.id === "actor-1")?.name).toBe(
      "Mannequin",
    );
    expect(graph).toEqual(createDefaultLogicGraphSerialized());
    const classHeader = readAssetDocumentHeader(
      await storage.readBinary(MAIN_CLASS_FILE),
    );
    expect(classHeader.type).toBe("Class");
    expect(classHeader.parentClass).toBe("Actor");
    expect(classHeader.name).toBe("main");
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
      ((await service.loadDocument("scene", MAIN_SCENE_FILE)) as SerializedScene)
        .name,
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
    ).toBe(3);
  });

  it("rebuilds a search index that finds the default Mannequin actor", async () => {
    const { service } = await scaffolded();
    expect(service.searchIndex).toBeTruthy();
    const hits = service.searchIndex!.query("mannequin");
    expect(
      hits.some((hit) => hit.kind === "actor" && hit.label === "Mannequin"),
    ).toBe(true);
  });

  it("updates search hits after saving a renamed actor", async () => {
    const { service } = await scaffolded();
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
        .searchIndex!.query("mannequin")
        .some((hit) => hit.kind === "actor" && hit.label === "Mannequin"),
    ).toBe(false);
    expect(
      service.searchIndex!.query("renamedhero").some((hit) => hit.kind === "actor"),
    ).toBe(true);
  });

  it("scaffolds Kenney Mannequin as a hierarchy rig with idle Anim Graph", async () => {
    const { storage, service } = await scaffolded();
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
    const model = registry!.list().find((asset) => asset.header.type === "Model");
    const skeleton = registry!
      .list()
      .find((asset) => asset.header.type === "Skeleton");
    const animations = registry!
      .list()
      .filter((asset) => asset.header.type === "Animation");
    expect(model?.header.name).toBe("mannequin");
    expect(mesh?.properties.assetGuid).toBe(model?.header.guid);
    expect(normalizeSkeletonPayload(skeleton?.header.payload).kind).toBe(
      "hierarchy",
    );
    expect(animations).toHaveLength(27);
    const idle = animations.find(
      (asset) =>
        normalizeAnimationPayload(asset.header.payload).clipName.toLowerCase() ===
        "idle",
    );
    expect(idle).toBeTruthy();

    expect(await storage.exists("assets/Mannequin.class.babasset")).toBe(true);
    expect(await storage.exists("assets/Mannequin.anim.babasset")).toBe(true);
    const classHeader = readAssetDocumentHeader(
      await storage.readBinary("assets/Mannequin.class.babasset"),
    );
    expect(classHeader.type).toBe("Class");
    expect(classHeader.parentClass).toBe("Actor");
    expect(classHeader.name).toBe("Mannequin");

    const graphDoc = await decodeAssetDocument(
      await storage.readBinary("assets/Mannequin.anim.babasset"),
    );
    expect(graphDoc.type).toBe("AnimationGraph");
    const clips = (graphDoc.payload as { clips?: Array<{ assetGuid?: string }> })
      .clips;
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

    await service.saveDocument("font", path, { ...payload, family: "Ui Display" });
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
    expect(
      saved.header.chunks.some((chunk) => chunk.id === "document"),
    ).toBe(false);
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
          { id: "source", kind: "geometry", mime: "model/gltf-binary", data: source },
        ],
      }),
    );

    const payload = (await service.loadDocument("model", path)) as Record<
      string,
      unknown
    >;
    await service.saveDocument("model", path, {
      ...payload,
      materialSlots: [
        { index: 0, name: "Hero Mat", materialGuid: "mat-new" },
      ],
    });

    const saved = await decodeBabasset(await storage.readBinary(path));
    expect(saved.header.type).toBe("Model");
    expect(saved.header.payload.clipNames).toEqual(["Walk"]);
    expect(saved.header.payload.materialSlots).toEqual([
      { index: 0, name: "Hero Mat", materialGuid: "mat-new" },
    ]);
    expect(saved.header.dependencies).toEqual(["mat-new"]);
    expect(saved.chunks.get("source")).toEqual(source);
    expect(
      saved.header.chunks.some((chunk) => chunk.id === "document"),
    ).toBe(false);
  });

  it("writes a Scene navmesh extra chunk without regenerating at Play", async () => {
    const { service } = await scaffolded();
    const scene = (await service.loadDocument(
      "scene",
      MAIN_SCENE_FILE,
    )) as SerializedScene;
    const bake = new Uint8Array([11, 22, 33, 44]);
    await service.writeSceneNavmeshChunk(MAIN_SCENE_FILE, bake, scene as unknown as Record<string, unknown>);
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(
      bake,
    );
    const again = new Uint8Array([99]);
    await service.writeSceneNavmeshChunk(
      MAIN_SCENE_FILE,
      again,
      scene as unknown as Record<string, unknown>,
    );
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(
      again,
    );
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
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, AUDIO_REVERB_CHUNK_ID)).toEqual(
      field,
    );
    expect(await service.readAssetChunk(MAIN_SCENE_FILE, NAVMESH_CHUNK_ID)).toEqual(
      new Uint8Array([1, 2]),
    );
  });

  it("keeps EditorUtilityInterface type and dockKind on the header after a ui save", async () => {
    const { storage, service } = await scaffolded();
    const path = "assets/SceneTools.eui.babasset";
    await storage.writeBinary(
      path,
      await encodeAssetDocument(
        {
          type: "EditorUtilityInterface",
          name: "SceneTools",
          guid: "eui-guid",
          version: 1,
          payload: { name: "SceneTools", dockKind: "scene", widgets: {} },
        },
        { headerMeta: { dockKind: "scene" } },
      ),
    );
    await service.remountRegistry();
    expect(
      service.registry?.list().find((asset) => asset.path === path)?.header.payload
        .dockKind,
    ).toBe("scene");
    const loaded = (await service.loadDocument("ui", path)) as Record<
      string,
      unknown
    >;
    await service.saveDocument("ui", path, {
      ...loaded,
      dockKind: "class",
      name: "ClassTools",
    });
    const header = readAssetDocumentHeader(await storage.readBinary(path));
    expect(header.type).toBe("EditorUtilityInterface");
    expect(header.payload.dockKind).toBe("class");
    const reloaded = (await service.loadDocument("ui", path)) as Record<
      string,
      unknown
    >;
    expect(reloaded.dockKind).toBe("class");
    expect(reloaded.name).toBe("ClassTools");
    expect(
      service.registry?.list().find((asset) => asset.path === path)?.header.payload
        .dockKind,
    ).toBe("class");
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
    await service.writeAudioClipChunk(
      path,
      "source:2",
      extra,
      "audio/ogg",
      { clips: [{ chunkId: "source", weight: 1 }, { chunkId: "source:2", weight: 1 }] },
    );
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
});

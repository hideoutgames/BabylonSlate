import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  documentKindForAssetType,
  ENGINE_COMPONENT_CLASS_IDS,
  type ProjectDocument,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@haptic/core";
import { validateAnimGraph, type AnimGraphDocument } from "@haptic/anim-graph";
import {
  decodeTileGid,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  TILESET_TERRAIN_STYLES,
  tilesetTerrainById,
  tilesetTileById,
  type TilesetPayload,
} from "@haptic/assets";
import { DEFAULT_EDIT_BYTE_BUDGET, EditSession } from "@haptic/edit";
import {
  normalizeParticleGraphDocument,
  validateParticleGraphDocument,
} from "@haptic/particle-graph";
import { physicsActorsDiagnostics } from "@haptic/physics";
import { loadCompiledModule } from "@haptic/runtime";
import { FEATURE_TEST_CHECK_SCENES } from "./feature-test-check";
import {
  lowerMaterialDocument,
  materializeMaterialInstances,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@haptic/shader-graph";
import { MemoryStorageAdapter } from "@haptic/vfs";
import {
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  isMaterialSamplerTextureAsset,
} from "../lib/content-browser-helpers";
import { loadOptionalEngineContent } from "../lib/engine-content";
import { FEATURE_TEST_OPTIONAL_SLOTS } from "../lib/feature-test/engine-content-files";
import { JournalBuffer } from "../lib/journal-buffer";
import { modelSimpleColliderCounter } from "../lib/physics-pairing-diagnostics";
import { DocumentEditingService } from "./document-editing-service";
import { DocumentService } from "./document-service";
import { createPlayContentService } from "./play-content-service";
import { ProjectService } from "./project-service";
import { SourceControlService } from "./source-control-service";
import { runProjectScene } from "../testing/run-project-scene";

/** Three seconds of Play: past every probe's Delay, the Game Instance's spawn and console command, and the streamed room. */
const PLAY_TICKS = 180;

/** Source types FeatureTest imports from repository content. */
const IMPORTED_ASSET_TYPES = ["Texture", "Model", "Skeleton", "Animation", "Material", "Font"] as const;

describe("FeatureTest starter", () => {
  const storage = new MemoryStorageAdapter("documents");
  let created: ProjectService;
  let reopened: ProjectService;
  let document: ProjectDocument;
  let migrationPending: readonly unknown[];

  beforeAll(async () => {
    created = new ProjectService(storage, { encode: async () => ({ ktx2: new Uint8Array(), wallMs: 0 }) });
    await created.createEmptyProject("FeatureTest", { kind: "feature-test" });
    reopened = new ProjectService(storage, { encode: async () => ({ ktx2: new Uint8Array(), wallMs: 0 }) });
    const loaded = await reopened.loadCurrentProject();
    document = loaded.document;
    migrationPending = loaded.migrationPending;
  }, 300_000);

  afterAll(() => {
    created?.dispose();
    reopened?.dispose();
  });

  async function sceneDocuments(): Promise<Array<SerializedScene | SerializedSceneLayer>> {
    const assets = reopened.registry!.list().filter(
      (asset) => asset.header.type === "Scene" || asset.header.type === "SceneLayer",
    );
    return Promise.all(
      assets.map(async (asset) =>
        (await reopened.loadDocument(asset.header.type === "Scene" ? "scene" : "scene-layer", asset.path)) as
          | SerializedScene
          | SerializedSceneLayer,
      ),
    );
  }

  it("reopens cleanly with every asset resolved", () => {
    expect(migrationPending).toEqual([]);
    const assets = reopened.registry!.list();
    expect(assets.filter((asset) => asset.placeholder || asset.header.type === "Unresolved")).toEqual([]);
  });

  it("contains every scene the Feature Test Check walks", () => {
    const missing = FEATURE_TEST_CHECK_SCENES
      .filter((scene) => reopened.registry!.getByPath(scene.path)?.header.type !== "Scene")
      .map((scene) => scene.path);
    expect(missing).toEqual([]);
  });

  it("showcases every engine component, asset type and engine base class", async () => {
    const registry = reopened.registry!;
    const assets = registry.list();
    const components: SerializedComponent[] = [];
    for (const scene of await sceneDocuments()) components.push(...scene.actors.flatMap((actor) => actor.components));
    for (const asset of assets) {
      if (asset.header.type === "Class") {
        const graph = (await reopened.loadDocument("graph", asset.path)) as SerializedGraph;
        components.push(...(graph.components ?? []));
      } else if (asset.header.type === "Prefab") {
        const prefab = (await reopened.loadDocument("prefab", asset.path)) as { components?: SerializedComponent[] };
        components.push(...(prefab.components ?? []));
      }
    }
    const classIds = new Set(components.map((component) => component.classId));
    expect(ENGINE_COMPONENT_CLASS_IDS.filter((classId) => !classIds.has(classId))).toEqual([]);

    const audioSlot = await loadOptionalEngineContent(FEATURE_TEST_OPTIONAL_SLOTS.loopAudio);
    const required = [...CREATABLE_ASSET_TYPES, ...IMPORTED_ASSET_TYPES, ...(audioSlot ? ["Audio"] : [])];
    const types = new Set(assets.map((asset) => asset.header.type));
    expect(required.filter((type) => !types.has(type))).toEqual([]);

    const parents = new Set(
      assets.filter((asset) => asset.header.type === "Class").map((asset) => asset.header.parentClass ?? ""),
    );
    expect(ENGINE_BASE_CLASSES.filter((base) => !parents.has(base))).toEqual([]);
  });

  it("paints a Tilemap with a terrain of every autotile style", async () => {
    const registry = reopened.registry!;
    const tilesets = new Map<string, TilesetPayload>();
    for (const asset of registry.list().filter((entry) => entry.header.type === "Tileset")) {
      tilesets.set(asset.header.guid, normalizeTilesetPayload(await reopened.loadDocument("tileset", asset.path)));
    }
    const painted = new Set<string>();
    for (const asset of registry.list().filter((entry) => entry.header.type === "Tilemap")) {
      const map = normalizeTilemapPayload(await reopened.loadDocument("tilemap", asset.path));
      for (const gid of new Set(map.layers.flatMap((layer) => layer.chunks.flatMap((chunk) => chunk.tiles)))) {
        const hit = decodeTileGid(map, gid, tilesets);
        const terrain = hit ? tilesetTileById(hit.tileset, hit.localId)?.terrain : undefined;
        const style = hit && terrain ? tilesetTerrainById(hit.tileset, terrain.id)?.style : undefined;
        if (style) painted.add(style);
      }
    }
    expect(TILESET_TERRAIN_STYLES.filter((style) => !painted.has(style))).toEqual([]);
  });

  it("opens every scene without rewriting its Class and Prefab instances", async () => {
    const documents = new DocumentService();
    const editing = new DocumentEditingService({
      documents,
      editSession: new EditSession({ maxBytes: DEFAULT_EDIT_BYTE_BUDGET }),
      project: reopened,
      sourceControl: new SourceControlService(),
      journal: new JournalBuffer(async () => {}),
      derivedStorage: () => Promise.reject(new Error("Recovery is not part of this test.")),
      bump: () => {},
      scheduleDebouncedSave: () => {},
      onHistoryCleared: () => {},
      registryTick: () => 0,
      isProjectDirty: () => false,
      onRecoveryResolved: () => {},
    });
    // A scene the open-time sync rewrites is dirty before the user touches it, and a later scene's
    // open asks to Save or Discard it. Every Class here is closed, so sync reads its header rows; this
    // test cannot exercise the key-order-insensitive comparison, because bodies and headers are written
    // with sorted keys. document-editing-service.test.ts covers key order and a Class that is open
    // while its Scene opens.
    const dirtyOnOpen: string[] = [];
    for (const asset of reopened.registry!.list().filter((entry) => entry.header.type === "Scene")) {
      const id = await documents.openDocument(
        reopened,
        { kind: "scene", path: asset.path, label: asset.header.name },
        null,
        true,
      );
      await editing.syncPrefabInstances({ quiet: true });
      if (documents.getDocument(id)!.dirty) dirtyOnOpen.push(asset.path);
    }
    expect(dirtyOnOpen).toEqual([]);
  });

  it("resolves every reference and decodes every document", async () => {
    const registry = reopened.registry!;
    for (const asset of registry.list()) {
      // Hard and soft references alike: a dangling soft reference fails only at runtime.
      for (const dependency of new Set([...asset.header.dependencies, ...registry.requiredDependenciesFor(asset.header.guid)])) {
        const target = registry.getByGuid(dependency);
        expect(target, `${asset.path} → ${dependency}`).toBeDefined();
        expect(target?.placeholder, `${asset.path} → ${dependency}`).toBeFalsy();
      }
      const kind = documentKindForAssetType(asset.header.type);
      if (!kind || kind === "trace") continue;
      await expect(reopened.loadDocument(kind, asset.path), asset.path).resolves.toBeTruthy();
    }
  });

  it("passes Play validation and compiles every graph", async () => {
    const playContent = createPlayContentService({
      documents: new DocumentService(),
      project: reopened,
      readAssetChunk: (path, chunk) => reopened.readAssetChunk(path, chunk),
      projectDocument: () => document,
      onPreviewScriptsCompiled: () => {},
    });
    const { bundles, diagnostics } = await playContent.collectPlayPreviewScripts();
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    // Play loads each generated module the same way; a codegen collision only surfaces here.
    const loadErrors: string[] = [];
    for (const bundle of bundles) {
      await loadCompiledModule(bundle.source, bundle.classId).catch((error: unknown) => {
        loadErrors.push(`${bundle.classId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    expect(loadErrors).toEqual([]);
  });

  it("loads every graph compiled with a Simulation's execution probes", async () => {
    const playContent = createPlayContentService({
      documents: new DocumentService(),
      project: reopened,
      readAssetChunk: (path, chunk) => reopened.readAssetChunk(path, chunk),
      projectDocument: () => document,
      onPreviewScriptsCompiled: () => {},
    });
    const { bundles } = await playContent.collectPlayPreviewScripts(undefined, undefined, undefined, { traceExecution: true });
    expect(bundles.some((bundle) => bundle.source.includes("__dbg"))).toBe(true);
    // The starter's Animation Graphs are probed too, their Animation Object graph under its own id.
    expect(bundles.some((bundle) => bundle.classId.startsWith("AnimGraph:") && bundle.source.includes('"animation-object")'))).toBe(true);
    const loadErrors: string[] = [];
    for (const bundle of bundles) {
      await loadCompiledModule(bundle.source, bundle.classId).catch((error: unknown) => {
        loadErrors.push(`${bundle.classId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    expect(loadErrors).toEqual([]);
  });

  it("compiles every Material and validates every Particle and Animation Graph", async () => {
    const registry = reopened.registry!;
    const assets = registry.list();
    const ofType = (type: string) => assets.filter((asset) => asset.header.type === type);
    const functions: Record<string, MaterialFunctionDocument> = {};
    for (const asset of ofType("MaterialFunction")) {
      functions[asset.header.guid] = normalizeMaterialFunctionDocument(
        await reopened.loadDocument("material-function", asset.path),
      );
    }
    const materials = new Map<string, MaterialDocument>();
    for (const asset of ofType("Material")) {
      materials.set(asset.header.guid, normalizeMaterialDocument(await reopened.loadDocument("material", asset.path)));
    }
    const instances = new Map();
    for (const asset of ofType("MaterialInstance")) {
      instances.set(
        asset.header.guid,
        normalizeMaterialInstanceDocument(await reopened.loadDocument("material-instance", asset.path)),
      );
    }
    // Instances render as their root graph with replaced parameter values.
    for (const [guid, material] of materializeMaterialInstances(materials, instances)) materials.set(guid, material);
    // Same sampler rule as the Material editor (Textures and Render Target Textures).
    const textureExists = (guid: string) => {
      const header = registry.getByGuid(guid)?.header;
      return header ? isMaterialSamplerTextureAsset(header) : false;
    };
    const materialErrors = [...materials].flatMap(([guid, material]) => {
      const lowered = lowerMaterialDocument(material, { functions, textureExists });
      return lowered.ok
        ? []
        : [{ path: registry.getByGuid(guid)?.path, errors: lowered.diagnostics.filter((row) => row.severity === "error") }];
    });
    expect(materialErrors).toEqual([]);

    for (const asset of ofType("ParticleGraph")) {
      const graph = normalizeParticleGraphDocument(await reopened.loadDocument("particle-graph", asset.path));
      expect(validateParticleGraphDocument(graph).filter((row) => row.severity === "error"), asset.path).toEqual([]);
    }
    for (const asset of ofType("AnimationGraph")) {
      const graph = (await reopened.loadDocument("anim-graph", asset.path)) as unknown as AnimGraphDocument;
      expect(validateAnimGraph(graph).filter((row) => row.severity === "error"), asset.path).toEqual([]);
    }
  });

  it("authors physics without pairing problems", async () => {
    const modelSimpleColliderCount = modelSimpleColliderCounter(reopened.registry);
    for (const scene of await sceneDocuments()) {
      // A SceneLayer simulates in its own 2D world.
      const physicsWorld = "viewportMode" in scene ? scene.settings.physicsWorld : "2d";
      expect(physicsActorsDiagnostics(scene.actors, { physicsWorld, modelSimpleColliderCount }), scene.name).toEqual([]);
    }
    for (const asset of reopened.registry!.list()) {
      if (asset.header.type !== "Class") continue;
      const graph = (await reopened.loadDocument("graph", asset.path)) as SerializedGraph;
      const actors = [{ id: asset.header.name, components: graph.components ?? [] }];
      expect(physicsActorsDiagnostics(actors, { modelSimpleColliderCount }), asset.path).toEqual([]);
    }
  });

  // Each scene plays headlessly as in editor Play: its probes assert what they check, so a broken feature fails here.
  for (const scene of FEATURE_TEST_CHECK_SCENES) {
    it(`plays ${scene.name} without session errors or failed asserts`, async () => {
      const run = await runProjectScene({ project: reopened, document, scenePath: scene.path, ticks: PLAY_TICKS });
      expect(run.problems).toEqual([]);
      expect(run.tickIndex).toBe(PLAY_TICKS);
    }, 120_000);
  }
});

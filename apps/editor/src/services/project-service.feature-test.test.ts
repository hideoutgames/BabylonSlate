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
import {
  blendSpaceNodeData,
  isBlendSpacePlayerType,
  resolveAnimGraphClips,
  validateAnimGraph,
  type AnimGraphDocument,
} from "@haptic/anim-graph";
import {
  decodeTileGid,
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  parseSpriteAnimationPayload,
  refreshStaleTilemapTerrains,
  tilemapPaintedExtent,
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
import { FEATURE_TEST_CHECK_SCENES } from "./feature-test-check-scenes";
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
import { animClipCatalogFromAssets } from "../lib/anim-clip-catalog";
import { ENGINE_BASE_CLASSES } from "../lib/class-asset-lookup";
import {
  CREATABLE_ASSET_TYPES,
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

  it("reopens an Animation whose authored Duration differs from its clip length", () => {
    const authored = reopened.registry!.list()
      .filter((asset) => asset.header.type === "Animation")
      .map((asset) => normalizeAnimationPayload(asset.header.payload))
      .filter((payload) => payload.durationMs !== payload.clipDurationMs);
    expect(authored.map(({ clipName, durationMs, clipDurationMs }) => ({ clipName, durationMs, clipDurationMs })))
      .toEqual([{ clipName: "open", durationMs: 1500, clipDurationMs: 1000 }]);
  });

  it("puts skinned characters with the same rig, and their rig's animation libraries, on one Skeleton", () => {
    const assets = reopened.registry!.list();
    const skeletonOfModel = (name: string) =>
      normalizeModelPayload(assets.find((asset) => asset.header.type === "Model" && asset.header.name === name)?.header.payload).skeletonGuid;
    const medium = skeletonOfModel("Knight");
    expect(medium).toBeTruthy();
    expect(skeletonOfModel("Rogue_Hooded")).toBe(medium);
    expect(skeletonOfModel("Rig_Medium_MovementBasic")).toBe(medium);
    const large = skeletonOfModel("Mannequin_Large");
    expect(large).toBeTruthy();
    expect(large).not.toBe(medium);
    const clipsOn = (skeleton: string | null) => assets
      .filter((asset) => asset.header.type === "Animation")
      .map((asset) => normalizeAnimationPayload(asset.header.payload))
      .filter((payload) => payload.skeletonGuid === skeleton)
      .map((payload) => payload.clipName);
    expect(clipsOn(medium)).toEqual(expect.arrayContaining(["Idle_A", "Interact", "PickUp", "Walking_A", "Running_A"]));
    expect(clipsOn(large)).toEqual(expect.arrayContaining(["Walking_A", "Running_A"]));
  });

  it("paints a Tilemap with a terrain of every autotile style, current with its Tilesets", async () => {
    const registry = reopened.registry!;
    const tilesets = new Map<string, TilesetPayload>();
    for (const asset of registry.list().filter((entry) => entry.header.type === "Tileset")) {
      tilesets.set(asset.header.guid, normalizeTilesetPayload(await reopened.loadDocument("tileset", asset.path)));
    }
    const painted = new Set<string>();
    for (const asset of registry.list().filter((entry) => entry.header.type === "Tilemap")) {
      const map = normalizeTilemapPayload(await reopened.loadDocument("tilemap", asset.path));
      // Loading never re-resolves the starter's terrain cells, so its hand-placed pieces stay.
      expect(refreshStaleTilemapTerrains(map, tilesets), asset.path).toBe(map);
      for (const gid of new Set(map.layers.flatMap((layer) => layer.chunks.flatMap((chunk) => chunk.tiles)))) {
        const hit = decodeTileGid(map, gid, tilesets);
        const terrain = hit ? tilesetTileById(hit.tileset, hit.localId)?.terrain : undefined;
        const style = hit && terrain ? tilesetTerrainById(hit.tileset, terrain.id)?.style : undefined;
        if (style) painted.add(style);
      }
    }
    expect(TILESET_TERRAIN_STYLES.filter((style) => !painted.has(style))).toEqual([]);
  });

  it("places an unbounded Tilemap with a pivot and tiles at negative cells in a scene", async () => {
    const registry = reopened.registry!;
    const unbounded = new Set<string>();
    for (const asset of registry.list().filter((entry) => entry.header.type === "Tilemap")) {
      const map = normalizeTilemapPayload(await reopened.loadDocument("tilemap", asset.path));
      const extent = tilemapPaintedExtent(map);
      if (map.unbounded && (map.pivot.x !== 0 || map.pivot.y !== 0) && extent && (extent.minX < 0 || extent.minY < 0)) {
        unbounded.add(asset.header.guid);
      }
    }
    const placed = (await sceneDocuments()).flatMap((scene) => scene.actors.flatMap((actor) => actor.components))
      .filter((component) => component.classId === "TilemapComponent" && unbounded.has(String(component.properties.assetGuid)));
    expect(placed.length).toBeGreaterThan(0);
  });

  it("plays Sprite Animations from Sprite frames and from a sheet's cells", async () => {
    const registry = reopened.registry!;
    const animations = await Promise.all(registry.list()
      .filter((entry) => entry.header.type === "SpriteAnimation")
      .map(async (asset) => parseSpriteAnimationPayload(await reopened.loadDocument("sprite-animation", asset.path))));
    const spriteFrames = animations.filter((animation) => animation.source === "frames" && animation.frames.some((frame) => frame.spriteGuid));
    const sheets = animations.filter((animation) => animation.source === "sheet" && animation.sheet.textureGuid && animation.frames.length > 1);
    expect({ spriteFrames: spriteFrames.length > 0, sheets: sheets.length > 0 }).toEqual({ spriteFrames: true, sheets: true });
  });

  it("overrides the project's Post Processing in a Scene", async () => {
    const overridden = (await sceneDocuments()).filter((scene) =>
      "viewportMode" in scene && Object.keys(scene.settings.effectsOverrides ?? {}).length > 0);
    expect(overridden.map((scene) => scene.name)).toContain("FT_Lights");
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
      await loadCompiledModule(bundle, bundle.classId).catch((error: unknown) => {
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
      await loadCompiledModule(bundle, bundle.classId).catch((error: unknown) => {
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
    const clipCatalog = animClipCatalogFromAssets(reopened.registry!.list());
    const blendSpacePlayers = new Set<string>();
    const syncGroupMembers = new Map<string, number>();
    let aliasTransitions = 0;
    for (const [type, kind, dimension] of [
      ["AnimationGraph3D", "anim-graph-3d", "3d"],
      ["AnimationGraph2D", "anim-graph-2d", "2d"],
    ] as const) {
      for (const asset of ofType(type)) {
        const graph = (await reopened.loadDocument(kind, asset.path)) as unknown as AnimGraphDocument;
        expect(validateAnimGraph(graph, clipCatalog, { dimension }).filter((row) => row.severity === "error"), asset.path).toEqual([]);
        const aliasIds = new Set((graph.stateMachine.aliases ?? []).map((alias) => alias.id));
        aliasTransitions += graph.stateMachine.transitions.filter((row) => aliasIds.has(row.fromStateId)).length;
        // Every Blend Space Player finds its samples in the catalog, as Play resolves them.
        for (const state of resolveAnimGraphClips(graph, clipCatalog).stateMachine.states) {
          for (const node of state.stateGraph.nodes) {
            const group = typeof node.data.syncGroup === "string" ? node.data.syncGroup : "";
            if (group) syncGroupMembers.set(`${asset.path}:${group}`, (syncGroupMembers.get(`${asset.path}:${group}`) ?? 0) + 1);
            if (!isBlendSpacePlayerType(node.type)) continue;
            blendSpacePlayers.add(node.type);
            expect(blendSpaceNodeData(node).samples.length, `${asset.path} ${state.name}`).toBeGreaterThan(1);
          }
        }
      }
    }
    // Both the 3D and the 2D Blend Space Player are showcased.
    expect([...blendSpacePlayers].sort()).toEqual(["anim.frame.spriteBlendSpacePlayer", "anim.pose.blendSpacePlayer"]);
    // A Sync Group is showcased: one graph has at least two players in the same group.
    expect(Math.max(0, ...syncGroupMembers.values())).toBeGreaterThan(1);
    // A State Alias with a transition is showcased.
    expect(aliasTransitions).toBeGreaterThan(0);
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
  // Event handlers whose asserts would pass by never running also print a line, which must appear.
  const HEARD: Partial<Record<(typeof FEATURE_TEST_CHECK_SCENES)[number]["name"], string[]>> = {
    main: ["Feature Test scene script heard On Intro Line (Intro) through FT_Timeline", "FT_HUD script plays its own FT_HudPulse"],
    FT_World: ["FT_TimelineListener heard On Door Open (Door Loop)", "FT_SwingDoor heard On Swing Open (FT_DoorSwing)"],
  };
  for (const scene of FEATURE_TEST_CHECK_SCENES) {
    it(`plays ${scene.name} without session errors or failed asserts`, async () => {
      const run = await runProjectScene({ project: reopened, document, scenePath: scene.path, ticks: PLAY_TICKS });
      expect(run.problems).toEqual([]);
      expect(run.tickIndex).toBe(PLAY_TICKS);
      for (const line of HEARD[scene.name] ?? []) expect(run.logs.filter((log) => log.includes(line)), line).not.toEqual([]);
    }, 120_000);
  }
});

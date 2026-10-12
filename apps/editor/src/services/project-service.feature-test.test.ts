import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  documentKindForAssetType,
  ENGINE_COMPONENT_CLASS_IDS,
  type ProjectDocument,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { validateAnimGraph, type AnimGraphDocument } from "@babylonslate/anim-graph";
import {
  normalizeParticleGraphDocument,
  validateParticleGraphDocument,
} from "@babylonslate/particle-graph";
import { physicsActorsDiagnostics } from "@babylonslate/physics";
import { loadCompiledModule } from "@babylonslate/runtime";
import { FEATURE_TEST_CHECK_SCENES } from "./feature-test-check";
import {
  lowerMaterialDocument,
  materializeMaterialInstances,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  CREATABLE_ASSET_TYPES,
  ENGINE_BASE_CLASSES,
  isMaterialSamplerTextureAsset,
} from "../lib/content-browser-helpers";
import { loadOptionalEngineContent } from "../lib/engine-content";
import { FEATURE_TEST_OPTIONAL_SLOTS } from "../lib/feature-test/engine-content-files";
import { DocumentService } from "./document-service";
import { createPlayContentService } from "./play-content-service";
import { ProjectService } from "./project-service";

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
    for (const scene of await sceneDocuments()) {
      expect(physicsActorsDiagnostics(scene.actors), scene.name).toEqual([]);
    }
  });
});

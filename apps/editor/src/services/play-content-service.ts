import {
  documentId,
  isInputAssetType,
  normalizeInputAssetPayload,
  normalizeRenderTargetPayload,
  normalizeRenderTargetTexturePayload,
  normalizeWaterDefinition,
  type InputAssetDefinition,
  type ProjectDocument,
  type RenderTargetPayload,
  type RenderTargetTexturePayload,
  type SerializedGraph,
  type SerializedScene,
  type WaterDefinition,
} from "@babylonslate/core";
import {
  decodeSourceToRgba,
  normalizeModelPayload,
  type ModelPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { sceneAssetClassId } from "@babylonslate/object-model";
import { encodeRgbaPng } from "@babylonslate/render";
import type { Diagnostic } from "@babylonslate/scripting";
import {
  materializeMaterialInstances,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  normalizeMaterialInstanceDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { createAppSettingsStore } from "@babylonslate/vfs";
import { collectAreaEmissions } from "../lib/collect-area-emissions";
import { collectGpuTextureBytes, texturePixelSizesFromHeaders } from "../lib/collect-gpu-texture-bytes";
import { classParentLookup, materialDomainsFromAssets } from "../lib/content-browser-helpers";
import { collectDataGraphAssets } from "../lib/data-graph";
import { selectEditorUtilityGraphs } from "../lib/editor-utility-scripts";
import { inputAssetCatalog } from "../lib/input-asset-catalog";
import {
  collectClassGraphsForPalette,
  collectGraphTypeAssets,
  collectSceneDocumentsForPalette,
  collectSubsystemClassesForPalette,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";
import { createPlayAudioSourceLoader, playAudioLibraryFromAssets } from "../lib/play-audio";
import {
  collectAnimGraphCompileDocuments,
  collectPlayScriptDocuments,
  materialClosureFromGuids,
  modelAssetGuidsFromScene,
  modelGuidsForPlayRetarget,
  playMaterialGuidsFromSources,
  playSpritePayloadsFromGuids,
  playTilemapPayloadsFromGuids,
  playTilesetPayloadsFromGuids,
  spriteAssetGuidsFromScene,
  textureGuidsFromPlayPayloads,
  tilemapAssetGuidsFromScene,
  tilesetGuidsFromTilemaps,
  type PlayAnimGraphEntry,
} from "../lib/play-content";
import { collectFontAssetEntries, collectFontCssStacks, collectFontFacetypeBytes, collectFontMsdfPair, fontGuidsForSceneRepresentation } from "../lib/play-fonts";
import { classAssetPaths, mergePluginEditorUtilityObjects } from "../lib/plugin-ui";
import { persistableDocumentContent } from "../lib/scene-layer-document";
import type { DocumentService, OpenDocument } from "./document-service";
import {
  classHierarchyFromParentOf,
  classMemberSymbolsFromGraphs,
  knownClassIdSet,
  validateSerializedGraph,
} from "./graph-validation";
import type { ProjectService } from "./project-service";
import {
  classIdForGraphPath,
  compileAnimGraphScripts,
  compileGraphDocuments,
  graphCompileSignature,
  GraphScriptCompileCache,
} from "./script-compiler";

/** Class graphs, Animation Graphs and the typed asset catalogs their compilation reads. */
export const GRAPH_SIGNATURE_KINDS = ["graph", "anim-graph", "input-action", "input-axis", "data-definition", "data-tree", "structure", "enum"] as const;

export interface PlayContentServiceOptions {
  documents: DocumentService;
  project: ProjectService;
  /** Chunk reads scoped to the active document's asset load scope. */
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>;
  /** The open project's settings and scene list, read when a loader runs. */
  projectDocument: () => ProjectDocument | null;
  /** A whole-project Play compile finished; the owner stores its bundles and signature. */
  onPreviewScriptsCompiled: (signature: string, bundles: ScriptBundleEntry[], diagnostics: Diagnostic[]) => void;
}

export type PlayContentService = ReturnType<typeof createPlayContentService>;

function openGraphCompileDocuments(
  documentService: DocumentService,
): Array<{ path: string; content: SerializedGraph }> {
  return documentService
    .getOpenDocumentsOrdered()
    .filter((doc) => doc.ref.kind === "graph" && doc.content)
    .map((doc) => ({
      path: doc.ref.path,
      content: doc.content as SerializedGraph,
    }));
}

/**
 * The compiled parts of open Animation Graphs as signature slices: the
 * Animation Object graph and each transition rule with its endpoints, which
 * decide the one-way rule decoration.
 */
function openAnimGraphSignatureSlices(
  documentService: DocumentService,
): Array<{ path: string; content: SerializedGraph }> {
  return documentService
    .getOpenDocumentsOrdered()
    .filter((doc) => doc.ref.kind === "anim-graph" && doc.content)
    .flatMap((doc) => {
      const parsed = parseAnimGraphDocument(doc.content);
      if (!parsed) return [];
      return [
        { path: `${doc.ref.path}#animation-object`, content: parsed.animationObject },
        ...parsed.transitions.map((transition) => ({
          path: `${doc.ref.path}#rule-${transition.id}:${transition.fromStateId}>${transition.toStateId}`,
          content: transition.ruleGraph,
        })),
      ];
    });
}

/** A Play session needs every asset in its closure; a whole-project pass logs and skips. */
function reportLoadFailure(label: string, path: string, error: unknown, required: boolean): void {
  if (required) {
    throw new Error(`Could not load ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  console.error(`[play] failed to load ${label} ${path}`, error);
}

/**
 * Play and export content collection, without React: the `collectPlay*`
 * loaders (open tabs override saved documents), Class / Animation Graph script
 * compilation with its codegen cache, and the compile signatures that decide
 * when Play bundles are stale. `DocumentProvider` creates one and exposes its
 * functions as actions; each keeps its identity for the service's lifetime.
 */
export function createPlayContentService(options: PlayContentServiceOptions) {
  const { documents: documentService, project: projectService, readAssetChunk } = options;
  const compileCache = new GraphScriptCompileCache();

  const collectGraphTypeSchemas = () => {
    return typeSchemasFromGraphAssets(
      collectGraphTypeAssets({
        assets: projectService.registry?.list() ?? [],
        openDocuments: [...documentService.getState().openDocuments.values()],
      }),
    );
  };

  /** Fingerprint of the open Class and Animation Graphs and the catalogs they compile against (node positions omitted). */
  const graphSignature = (tags: ProjectDocument["settings"]["tags"] | undefined) => graphCompileSignature(
    [...openGraphCompileDocuments(documentService), ...openAnimGraphSignatureSlices(documentService)],
    inputAssetCatalog(projectService.registry?.list() ?? [], [...documentService.getState().openDocuments.values()]),
    tags,
    collectDataGraphAssets(projectService.registry?.list() ?? [], [...documentService.getState().openDocuments.values()]),
    collectGraphTypeSchemas(),
  );

  const recordPlayPreviewScripts = (bundles: ScriptBundleEntry[], nextDiagnostics: Diagnostic[]) => {
    options.onPreviewScriptsCompiled(graphSignature(options.projectDocument()?.settings.tags), bundles, nextDiagnostics);
  };

  /**
   * Compile on Save: warm the codegen cache for open Class and Animation
   * Graphs only and return their signature. Play bundles are not recorded;
   * Play still runs `collectPlayPreviewScripts` for the full set.
   */
  const compileOpenGraphs = (tags: ProjectDocument["settings"]["tags"] | undefined): string => {
    const assets = projectService.registry?.list() ?? [];
    const openDocuments = documentService.getOpenDocumentsOrdered();
    const graphs = openDocuments
      .filter((doc) => doc.ref.kind === "graph" && doc.content)
      .map((doc) => {
        const asset = assets.find((entry) => entry.path === doc.ref.path);
        return {
          path: doc.ref.path,
          content: doc.content as SerializedGraph,
          parentClassId: asset?.header.parentClass ?? null,
        };
      });
    const animGraphs = openDocuments
      .filter((doc) => doc.ref.kind === "anim-graph" && doc.content)
      .map((doc) => ({
        guid: assets.find((entry) => entry.path === doc.ref.path)?.header.guid ?? doc.ref.path,
        path: doc.ref.path,
        document: doc.content,
      }));
    const typeSchemas = collectGraphTypeSchemas();
    const inputAssets = inputAssetCatalog(assets, [...documentService.getState().openDocuments.values()]);
    const dataAssets = collectDataGraphAssets(assets, [...documentService.getState().openDocuments.values()]);
    compileGraphDocuments(graphs, {
      inputAssets,
      dataAssets,
      cache: compileCache,
      enums: typeSchemas.enums,
      structs: typeSchemas.structs,
      dataDefinitions: typeSchemas.dataDefinitions,
      tagRegistry: tags,
    });
    compileAnimGraphScripts(animGraphs, { cache: compileCache, inputAssets, dataAssets, ...typeSchemas, tagRegistry: tags });
    return graphCompileSignature(
      [...graphs, ...openAnimGraphSignatureSlices(documentService)],
      inputAssets,
      tags,
      dataAssets,
      typeSchemas,
    );
  };

  /** `strict` fails on an unreadable Class instead of compiling without it. */
  const loadClassGraphDocuments = async (requiredGuids?: ReadonlySet<string>, sourceDocuments?: readonly OpenDocument[], strict = false): Promise<
    Array<{ path: string; content: SerializedGraph }>
  > => {
    const paths = classAssetPaths((projectService.registry?.list() ?? []).filter((asset) => !requiredGuids || requiredGuids.has(asset.header.guid)));
    const open = sourceDocuments ? new Map(sourceDocuments.map(document => [document.id, document])) : documentService.getState().openDocuments;
    const documents: Array<{ path: string; content: SerializedGraph }> = [];
    for (const path of paths) {
      const openDoc = open.get(documentId({ kind: "graph", path }));
      if (openDoc?.content) {
        documents.push({ path, content: openDoc.content as SerializedGraph });
        continue;
      }
      try {
        const content = (await projectService.loadDocument(
          "graph",
          path,
        )) as SerializedGraph;
        documents.push({ path, content });
      } catch (error) {
        reportLoadFailure("Class", path, error, strict);
      }
    }
    return documents;
  };

  const loadProjectGraphDocuments = async (requiredGuids?: ReadonlySet<string>, sourceDocuments?: readonly OpenDocument[], strict = false): Promise<
    Array<{
      path: string;
      content: SerializedGraph;
      classId?: string;
      parentClassId?: string | null;
    }>
  > => {
    const documents = await loadClassGraphDocuments(requiredGuids, sourceDocuments, strict);
    const assets = projectService.registry?.list() ?? [];
    const headers = Object.fromEntries(
      assets.map((asset) => [
        asset.path,
        {
          type: asset.header.type,
          parentClass: asset.header.parentClass ?? null,
          name: asset.header.name,
        },
      ]),
    );
    const parentOf = classParentLookup(assets);
    return collectPlayScriptDocuments(documents, headers, parentOf);
  };

  const loadProjectAnimGraphDocuments = async (requiredGuids?: ReadonlySet<string>, sourceDocuments?: readonly OpenDocument[], strict = false) => {
    const assets = (projectService.registry?.list() ?? []).filter(
      (asset) => asset.header.type === "AnimationGraph" && (!requiredGuids || requiredGuids.has(asset.header.guid)),
    );
    const open = sourceDocuments ? new Map(sourceDocuments.map(document => [document.id, document])) : documentService.getState().openDocuments;
    const entries: PlayAnimGraphEntry[] = [];
    for (const asset of assets) {
      const openDoc = open.get(
        documentId({ kind: "anim-graph", path: asset.path }),
      );
      if (openDoc?.content) {
        entries.push({ guid: asset.header.guid, document: openDoc.content });
        continue;
      }
      try {
        entries.push({
          guid: asset.header.guid,
          document: await projectService.loadDocument("anim-graph", asset.path),
        });
      } catch (error) {
        reportLoadFailure("Animation Graph", asset.path, error, strict);
      }
    }
    return collectAnimGraphCompileDocuments(
      entries,
      (guid) => assets.find((asset) => asset.header.guid === guid)?.path ?? null,
    );
  };

  const collectEditorUtilityScripts = async (): Promise<
    ScriptBundleEntry[]
  > => {
    const assets = projectService.registry?.list() ?? [];
    const headers = Object.fromEntries(
      assets.map((asset) => [
        asset.path,
        { type: asset.header.type, parentClass: asset.header.parentClass ?? null },
      ]),
    );
    const parentOf = classParentLookup(assets);
    const registered = mergePluginEditorUtilityObjects(
      options.projectDocument()?.settings.editorUtilityObjects ?? [],
      projectService.plugins
        .filter((plugin) =>
          projectService.registry?.getRoot(`plugin:${plugin.pluginGuid}`),
        )
        .map((plugin) => plugin.settings),
    );
    const classIds = new Set(registered.map((id) => id.trim()).filter(Boolean));
    const selectedGuids = new Set(assets
      .filter((asset) => classIds.has(classIdForGraphPath(asset.path)))
      .map((asset) => asset.header.guid));
    const documents = await loadClassGraphDocuments(selectedGuids);
    const selected = selectEditorUtilityGraphs(documents, {
      headers,
      parentOf,
      registeredClassIds: registered,
    });
    const typeSchemas = collectGraphTypeSchemas();
    return compileGraphDocuments(selected, {
      inputAssets: inputAssetCatalog(projectService.registry?.list() ?? [], [...documentService.getState().openDocuments.values()]),
      dataAssets: collectDataGraphAssets(projectService.registry?.list() ?? [], [...documentService.getState().openDocuments.values()]),
      cache: compileCache,
      enums: typeSchemas.enums,
      structs: typeSchemas.structs,
      dataDefinitions: typeSchemas.dataDefinitions,
      tagRegistry: options.projectDocument()?.settings.tags,
    });
  };

  const collectPlayPreviewScripts = async (requiredGuids?: ReadonlySet<string>, sourceDocuments?: readonly OpenDocument[], sourceProject?: ProjectDocument): Promise<{
    bundles: ScriptBundleEntry[];
    diagnostics: Diagnostic[];
  }> => {
    // A Play session's closure is required content; a whole-project compile skips unreadable files.
    const strict = requiredGuids !== undefined;
    const documents = await loadProjectGraphDocuments(requiredGuids, sourceDocuments, strict);
    const animDocuments = await loadProjectAnimGraphDocuments(requiredGuids, sourceDocuments, strict);
    const parentOf = classParentLookup(projectService.registry?.list() ?? []);
    const assets = projectService.registry?.list() ?? [];
    const openDocuments = sourceDocuments ?? [...documentService.getState().openDocuments.values()];
    const classGraphs = collectClassGraphsForPalette({
      assets,
      openDocuments,
      classIdForPath: classIdForGraphPath,
    });
    for (const doc of documents) {
      classGraphs[classIdForGraphPath(doc.path)] = doc.content;
    }
    const typeSchemas = typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets, openDocuments }));
    const sceneClassIds = collectSceneDocumentsForPalette({
      assets,
      openDocuments,
    }).map((scene) => sceneAssetClassId(scene.guid));
    const subsystemClasses = collectSubsystemClassesForPalette({
      assets,
      openDocuments,
      parentOf,
      classIdForPath: classIdForGraphPath,
    });
    const diagnostics = documents.flatMap((doc) =>
      validateSerializedGraph(doc.content, {
        assetGuid: doc.path,
        graphId: documentId({ kind: "graph", path: doc.path }),
        classId: doc.classId ?? classIdForGraphPath(doc.path),
        hierarchy: classHierarchyFromParentOf(parentOf),
        members: classMemberSymbolsFromGraphs(classGraphs, { parentOf }),
        knownClassIds: knownClassIdSet(parentOf, [
          ...Object.keys(classGraphs),
          ...sceneClassIds,
        ]),
        inputAssets: inputAssetCatalog(projectService.registry?.list() ?? [], openDocuments),
        dataAssets: collectDataGraphAssets(projectService.registry?.list() ?? [], openDocuments),
        enums: typeSchemas.enums,
        structs: typeSchemas.structs,
        dataDefinitions: typeSchemas.dataDefinitions,
        materialDomains: materialDomainsFromAssets(
          projectService.registry?.list() ?? [],
          openDocuments,
        ),
        parentOf,
        otherClassGraphs: classGraphs,
        subsystemClasses,
      }),
    );
    const bundles = [
      ...compileGraphDocuments(documents, {
        inputAssets: inputAssetCatalog(projectService.registry?.list() ?? [], openDocuments),
        dataAssets: collectDataGraphAssets(projectService.registry?.list() ?? [], openDocuments),
        enums: typeSchemas.enums,
        structs: typeSchemas.structs,
        dataDefinitions: typeSchemas.dataDefinitions,
        tagRegistry: (sourceProject ?? options.projectDocument())?.settings.tags,
        cache: requiredGuids ? undefined : compileCache,
      }),
      ...compileAnimGraphScripts(animDocuments, {
        cache: requiredGuids ? undefined : compileCache,
        inputAssets: inputAssetCatalog(assets, openDocuments),
        dataAssets: collectDataGraphAssets(assets, openDocuments),
        ...typeSchemas,
        tagRegistry: (sourceProject ?? options.projectDocument())?.settings.tags,
      }),
    ];
    if (!requiredGuids) recordPlayPreviewScripts(bundles, diagnostics);
    return { bundles, diagnostics };
  };

  const loadPlayAssetContent = async (
    kind:
      | "anim-graph"
      | "behaviour-tree"
      | "blackboard"
      | "sprite"
      | "sprite-animation"
      | "tileset"
      | "tilemap"
      | "material"
      | "material-function"
      | "material-instance"
      | "audio-mixer"
      | "audio-channel"
      | "sound-attenuation"
      | "particle-emitter"
      | "particle-graph"
      | "particle-system"
      | "water"
      | "render-target"
      | "render-target-texture"
      | "model"
      | "skeleton"
      | "animation"
      | "input-action"
      | "input-axis"
      | "data-definition"
      | "data-tree"
      | "structure"
      | "enum"
      | "audio"
      | "scene-layer"
      | "texture"
      | "asset-settings",
    path: string,
  ): Promise<unknown | null> => {
    const openDoc = documentService
      .getState()
      .openDocuments.get(documentId({ kind, path }));
    if (openDoc?.content) return openDoc.content;
    try {
      return await projectService.loadDocument(kind, path);
    } catch (error) {
      console.error(`[play] failed to load ${kind} ${path}`, error);
      return null;
    }
  };

  const collectPlaySpritePayloads = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
  ): Promise<Map<string, SpritePayload>> => {
    const assets = projectService.registry?.list() ?? [];
    const byGuid = new Map(
      assets
        .filter((asset) => asset.header.type === "Sprite")
        .map((asset) => [asset.header.guid, asset]),
    );
    const loaded = new Map<string, unknown>();
    const needed = new Set([
      ...spriteAssetGuidsFromScene(scene),
      ...extraScenes.flatMap((entry) => spriteAssetGuidsFromScene(entry)),
    ]);
    for (const guid of needed) {
      const asset = byGuid.get(guid);
      if (!asset) continue;
      const content = await loadPlayAssetContent("sprite", asset.path);
      if (content) loaded.set(guid, content);
    }
    return playSpritePayloadsFromGuids(
      [...loaded.keys()],
      (guid) => loaded.get(guid) ?? null,
    );
  };

  const collectPlayWaterContent = async (requiredGuids?: ReadonlySet<string>): Promise<Map<string, WaterDefinition>> => {
    const waters = new Map<string, WaterDefinition>();
    for (const asset of projectService.registry?.list() ?? []) {
      if (asset.header.type !== "Water" || (requiredGuids && !requiredGuids.has(asset.header.guid))) continue;
      const content = await loadPlayAssetContent("water", asset.path);
      if (content) waters.set(asset.header.guid, normalizeWaterDefinition(content));
    }
    return waters;
  };

  const collectPlayRenderTargets = async (requiredGuids?: ReadonlySet<string>) => {
    const renderTargets = new Map<string, RenderTargetPayload>();
    const renderTargetTextures = new Map<string, RenderTargetTexturePayload>();
    for (const asset of projectService.registry?.list() ?? []) {
      if (requiredGuids && !requiredGuids.has(asset.header.guid)) continue;
      if (asset.header.type === "RenderTarget") {
        const content = await loadPlayAssetContent("render-target", asset.path);
        if (content) renderTargets.set(asset.header.guid, normalizeRenderTargetPayload(content));
      } else if (asset.header.type === "RenderTargetTexture") {
        const content = await loadPlayAssetContent("render-target-texture", asset.path);
        if (content) renderTargetTextures.set(asset.header.guid, normalizeRenderTargetTexturePayload(content));
      }
    }
    return { renderTargets, renderTargetTextures };
  };

  const collectPlayTilemapContent = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
  ): Promise<{
    tilemaps: Map<string, TilemapPayload>;
    tilesets: Map<string, TilesetPayload>;
  }> => {
    const assets = projectService.registry?.list() ?? [];
    const tilemapsByGuid = new Map(
      assets
        .filter((asset) => asset.header.type === "Tilemap")
        .map((asset) => [asset.header.guid, asset]),
    );
    const tilesetsByGuid = new Map(
      assets
        .filter((asset) => asset.header.type === "Tileset")
        .map((asset) => [asset.header.guid, asset]),
    );
    const loadedMaps = new Map<string, unknown>();
    for (const guid of [
      ...tilemapAssetGuidsFromScene(scene),
      ...extraScenes.flatMap((entry) => tilemapAssetGuidsFromScene(entry)),
    ]) {
      const asset = tilemapsByGuid.get(guid);
      if (!asset) continue;
      const content = await loadPlayAssetContent("tilemap", asset.path);
      if (content) loadedMaps.set(guid, content);
    }
    const tilemaps = playTilemapPayloadsFromGuids(
      [...loadedMaps.keys()],
      (guid) => loadedMaps.get(guid) ?? null,
    );
    const loadedSets = new Map<string, unknown>();
    for (const guid of tilesetGuidsFromTilemaps(tilemaps)) {
      const asset = tilesetsByGuid.get(guid);
      if (!asset) continue;
      const content = await loadPlayAssetContent("tileset", asset.path);
      if (content) loadedSets.set(guid, content);
    }
    return {
      tilemaps,
      tilesets: playTilesetPayloadsFromGuids(
        [...loadedSets.keys()],
        (guid) => loadedSets.get(guid) ?? null,
      ),
    };
  };

  const collectPlayAreaEmissions = async (scenes: readonly (SerializedScene | null | undefined)[], includeGraphs = false) => collectAreaEmissions({
    assets: projectService.registry?.list() ?? [], scenes,
    graphs: includeGraphs ? (await loadProjectGraphDocuments()).map((entry) => entry.content) : undefined,
    readChunk: (path, id) => readAssetChunk(path, id),
    onDiagnostic: (message) => console.warn(message),
  });

  const collectPlayTextureBytes = async (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
    extraGuids: readonly string[] = [],
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
    includeMaterialParameterTextures = false,
  ): Promise<Map<string, Uint8Array>> => {
    const assets = projectService.registry?.list() ?? [];
    const settings = await createAppSettingsStore().load();
    const guids = [
      ...textureGuidsFromPlayPayloads(sprites, tilesets, spriteAnimations),
      ...extraGuids,
    ];
    return collectGpuTextureBytes({
      assets,
      guids,
      // Play compiles all gameplay classes, including later Spawn Actor
      // targets; use that same set and its function graphs for texture literals.
      graphs: includeMaterialParameterTextures
        ? (await loadProjectGraphDocuments()).map((entry) => entry.content)
        : undefined,
      readChunk: (path, chunkId) =>
        readAssetChunk(path, chunkId),
      editorLod: {
        enabled: settings.editorTextureLodEnabled,
        quality: settings.editorTextureLodQuality,
      },
      downsampleSource: async (bytes, targetEdge) => {
        const decoded = await decodeSourceToRgba(bytes, targetEdge);
        return encodeRgbaPng(decoded.width, decoded.height, decoded.rgba);
      },
      onMissingKtx2: (guid) => {
        void projectService.retryTextureEncoding(guid);
      },
    });
  };

  const collectPlayTexturePixelSizes = (
    sprites: ReadonlyMap<string, SpritePayload>,
    tilesets: ReadonlyMap<string, TilesetPayload>,
    extraGuids: readonly string[] = [],
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>,
  ): Map<string, { width: number; height: number }> => {
    const assets = projectService.registry?.list() ?? [];
    const guids = [
      ...textureGuidsFromPlayPayloads(sprites, tilesets, spriteAnimations),
      ...extraGuids,
    ];
    return texturePixelSizesFromHeaders(assets, guids);
  };

  const collectPlayFontFacetypeBytes = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
  ): Promise<Map<string, Uint8Array>> => {
    const assets = projectService.registry?.list() ?? [];
    const sources = assets.map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
      payload: asset.header.payload,
    }));
    return collectFontFacetypeBytes(
      sources,
      fontGuidsForSceneRepresentation([scene, ...extraScenes], sources, "facetype"),
      (path, chunkId) => readAssetChunk(path, chunkId),
    );
  };

  const collectPlayFontMsdfPair = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
  ) => {
    const assets = projectService.registry?.list() ?? [];
    const sources = assets.map((asset) => ({
      guid: asset.header.guid,
      path: asset.path,
      type: asset.header.type,
      payload: asset.header.payload,
    }));
    return collectFontMsdfPair(
      sources,
      fontGuidsForSceneRepresentation([scene, ...extraScenes], sources, "msdf", options.projectDocument()?.settings.fonts.defaultFontGuid),
      (path, chunkId) => readAssetChunk(path, chunkId),
    );
  };

  const collectPlayFontFaceEntries = async (requiredGuids?: ReadonlySet<string>) => {
    const assets = (projectService.registry?.list() ?? []).filter((asset) => !requiredGuids || requiredGuids.has(asset.header.guid));
    return collectFontAssetEntries(
      assets.map((asset) => ({
        guid: asset.header.guid,
        path: asset.path,
        type: asset.header.type,
        payload: asset.header.payload,
      })),
      (path, chunkId) => readAssetChunk(path, chunkId),
    );
  };

  const collectPlayFontCssStacks = () => {
    const assets = projectService.registry?.list() ?? [];
    return collectFontCssStacks(
      assets.map((asset) => ({
        guid: asset.header.guid,
        path: asset.path,
        type: asset.header.type,
        payload: asset.header.payload,
      })),
      options.projectDocument()?.settings.fonts,
    );
  };

  const collectPlayModelBytes = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
    requiredGuids?: ReadonlySet<string>,
  ): Promise<Map<string, Uint8Array>> => {
    const assets = projectService.registry?.list() ?? [];
    const byGuid = new Map(
      assets.map((asset) => [asset.header.guid, asset] as const),
    );
    const bytes = new Map<string, Uint8Array>();
    const animationRows = assets
      .filter((asset) => asset.header.type === "Animation" && (!requiredGuids || requiredGuids.has(asset.header.guid)))
      .map((asset) => ({
        guid: asset.header.guid,
        payload: asset.header.payload,
      }));
    for (const guid of modelGuidsForPlayRetarget(
      [
        ...modelAssetGuidsFromScene(scene),
        ...extraScenes.flatMap((entry) => modelAssetGuidsFromScene(entry)),
      ],
      animationRows,
    )) {
      const asset = byGuid.get(guid);
      if (!asset) continue;
      const source = await readAssetChunk(asset.path, "source");
      if (source && source.byteLength > 0) bytes.set(guid, source);
    }
    return bytes;
  };

  const collectPlayModelPayloads = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
  ): Promise<Map<string, ModelPayload>> => {
    const assets = projectService.registry?.list() ?? [];
    const byGuid = new Map(
      assets
        .filter((asset) => asset.header.type === "Model")
        .map((asset) => [asset.header.guid, asset] as const),
    );
    const payloads = new Map<string, ModelPayload>();
    for (const guid of [
      ...modelAssetGuidsFromScene(scene),
      ...extraScenes.flatMap((entry) => modelAssetGuidsFromScene(entry)),
    ]) {
      const asset = byGuid.get(guid);
      if (!asset) continue;
      const content =
        (await loadPlayAssetContent("model", asset.path)) ??
        asset.header.payload;
      payloads.set(guid, normalizeModelPayload(content ?? {}));
    }
    return payloads;
  };

  const collectPlayInputAssets = async (requiredGuids?: ReadonlySet<string>): Promise<InputAssetDefinition[]> => {
    const inputs: InputAssetDefinition[] = [];
    for (const asset of projectService.registry?.list() ?? []) {
      if (!isInputAssetType(asset.header.type) || (requiredGuids && !requiredGuids.has(asset.header.guid))) continue;
      const content = await loadPlayAssetContent(asset.header.type === "InputAction" ? "input-action" : "input-axis", asset.path);
      if (!content) throw new Error(`Unable to load input asset ${asset.header.name}`);
      inputs.push({ ...normalizeInputAssetPayload(asset.header.type, content), guid: asset.header.guid, name: asset.header.name, type: asset.header.type });
    }
    return inputs;
  };

  const collectPlayAudio = async (requiredGuids?: ReadonlySet<string>) => {
    const assets = (projectService.registry?.list() ?? []).filter((asset) => !requiredGuids || requiredGuids.has(asset.header.guid));
    const audioAssets = assets.filter((asset) =>
      ["Audio", "AudioMixer", "AudioChannel", "SoundAttenuation"].includes(
        asset.header.type,
      ),
    );
    const payloads: Array<{ guid: string; type: string; payload: unknown }> = [];
    for (const asset of audioAssets) {
      const kind =
        asset.header.type === "AudioMixer"
          ? "audio-mixer"
          : asset.header.type === "AudioChannel"
            ? "audio-channel"
            : asset.header.type === "SoundAttenuation"
              ? "sound-attenuation"
              : "audio";
      const content =
        (await loadPlayAssetContent(kind, asset.path)) ?? asset.header.payload;
      payloads.push({
        guid: asset.header.guid,
        type: asset.header.type,
        payload: content,
      });
    }
    return {
      library: playAudioLibraryFromAssets({
        mixerGuid: options.projectDocument()?.settings.audio.audioMixerGuid ?? null,
        assets: payloads,
      }),
      loadSourceBytes: createPlayAudioSourceLoader({
        assets: audioAssets.map((asset, index) => ({
          guid: asset.header.guid,
          path: asset.path,
          type: asset.header.type,
          payload: payloads[index]?.payload,
        })),
        readChunk: (path, chunkId) =>
          readAssetChunk(path, chunkId),
      }),
    };
  };

  const collectPlayMaterialLibrary = async (
    scene?: SerializedScene | null,
    extraScenes: readonly SerializedScene[] = [],
    extraMaterialGuids: readonly string[] = [],
  ): Promise<{
    documents: Map<string, MaterialDocument>;
    functions: Map<string, MaterialFunctionDocument>;
    textureGuids: string[];
  }> => {
    const assets = projectService.registry?.list() ?? [];
    const byGuid = new Map(
      assets.map((asset) => [asset.header.guid, asset] as const),
    );
    const loaded = new Map<string, unknown>();
    const loadGuid = async (guid: string) => {
      if (loaded.has(guid)) return;
      const asset = byGuid.get(guid);
      if (!asset) return;
      const kind =
        asset.header.type === "MaterialFunction"
          ? "material-function"
          : asset.header.type === "Material"
            ? "material"
            : asset.header.type === "MaterialInstance"
              ? "material-instance"
              : null;
      if (!kind) return;
      const content = await loadPlayAssetContent(kind, asset.path);
      if (content) loaded.set(guid, content);
    };
    const needed = new Set(
      playMaterialGuidsFromSources(
        [scene, ...extraScenes],
        extraMaterialGuids,
      ),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const guid of [...needed]) await loadGuid(guid);
      const closure = materialClosureFromGuids([...needed], (guid) =>
        loaded.get(guid) ?? null,
      );
      for (const guid of closure.referenced) {
        if (needed.has(guid)) continue;
        needed.add(guid);
        grew = true;
      }
    }
    const closure = materialClosureFromGuids([...needed], (guid) =>
      loaded.get(guid) ?? null,
    );
    const documents = new Map<string, MaterialDocument>();
    const functions = new Map<string, MaterialFunctionDocument>();
    for (const guid of closure.materials) {
      const content = loaded.get(guid);
      if (content) documents.set(guid, normalizeMaterialDocument(content));
    }
    for (const guid of closure.functions) {
      const content = loaded.get(guid);
      if (content) {
        functions.set(guid, normalizeMaterialFunctionDocument(content));
      }
    }
    // Instances render as their root graph with replaced parameter values.
    const instances = new Map(closure.instances.flatMap((guid) => {
      const content = loaded.get(guid);
      return content ? [[guid, normalizeMaterialInstanceDocument(content)] as const] : [];
    }));
    for (const [guid, document] of materializeMaterialInstances(documents, instances)) {
      documents.set(guid, document);
    }
    return { documents, functions, textureGuids: closure.textures };
  };

  return {
    collectGraphTypeSchemas,
    graphSignature,
    compileOpenGraphs,
    /** Drop cached codegen (project open and close). */
    clearCompileCache: () => compileCache.clear(),
    collectPlayPreviewScripts,
    collectEditorUtilityScripts,
    collectPlaySpritePayloads,
    collectPlayWaterContent,
    collectPlayRenderTargets,
    collectPlayTilemapContent,
    collectPlayAreaEmissions,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayInputAssets,
    collectPlayAudio,
    collectPlayMaterialLibrary,
  };
}

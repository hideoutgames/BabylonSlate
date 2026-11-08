import { useEffect, useMemo, useRef, useState } from "react";
import type { SaveGameDefinition, SerializedScene } from "@haptic/core";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import {
  classParentLookup,
  materialDomainsFromAssets,
} from "../lib/content-browser-helpers";
import { inputAssetCatalog } from "../lib/input-asset-catalog";
import { collectDataGraphAssets } from "../lib/data-graph";
import {
  collectFunctionLibraryHeaders,
  collectGraphTypeAssets,
  collectSceneHeadersForPalette,
  collectScriptInterfacesForPalette,
  collectSubsystemClassesForPalette,
  typeSchemasFromGraphAssets,
  withOpenFunctionLibraries,
  withOpenScenesForPalette,
  type PaletteSceneDocument,
} from "../lib/logic-graph-document";
import { useClassGraphs } from "../lib/use-class-graphs";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import { classHierarchyFromParentOf } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { defaultSaveGameDefinition, loadDefaultSaveGameDefinition, resolveSaveGameDefinition } from "../lib/save-game-catalog";
import { projectTimelineClips } from "../lib/timeline-asset-index";
import { timelineScriptAssets, type TimelineScriptAsset } from "../lib/timeline-script-catalog";

const CLASS_KINDS = ["graph"] as const;
const SCENE_KINDS = ["scene"] as const;
const CLIP_DOCUMENT_KINDS = ["scene", "scene-layer", "timeline-clip-2d", "timeline-clip-3d"] as const;
const INTERFACE_KINDS = ["script-interface"] as const;
const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;
const INPUT_KINDS = ["input-action", "input-axis"] as const;
const DATA_KINDS = ["data-tree"] as const;
const SAVE_GAME_KINDS = ["save-game"] as const;

/** Two palette Scene lists that name the same Scenes, actors and component lists. */
function samePaletteScenes(a: readonly PaletteSceneDocument[], b: readonly PaletteSceneDocument[]): boolean {
  return a.length === b.length && a.every((scene, index) => {
    const other = b[index]!;
    return scene.guid === other.guid && scene.name === other.name && (scene.actors === other.actors || (
      scene.actors.length === other.actors.length &&
      scene.actors.every((actor, at) => actor.name === other.actors[at]!.name && actor.components === other.actors[at]!.components)
    ));
  });
}

type ClipSource = { ref: { kind: string; path: string }; content: unknown };

function readsSceneClips(source: ClipSource): boolean {
  return Boolean(source.content) && (source.ref.kind === "scene" || source.ref.kind === "scene-layer");
}

/** What `projectTimelineClips` reads of an open document: a Scene's clip list, or a clip asset's content. */
function clipSource(doc: ClipSource): ClipSource {
  if (!readsSceneClips(doc)) return doc;
  return { ref: doc.ref, content: { timelineClips: (doc.content as SerializedScene).timelineClips } };
}

function clipSourceValue(source: ClipSource): unknown {
  return readsSceneClips(source) ? (source.content as Pick<SerializedScene, "timelineClips">).timelineClips : source.content;
}

function sameClipSources(a: readonly ClipSource[], b: readonly ClipSource[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!;
    return entry.ref.kind === other.ref.kind && entry.ref.path === other.ref.path &&
      clipSourceValue(entry) === clipSourceValue(other);
  });
}

/**
 * The project-wide catalogs a Class or Animation Graph panel builds its
 * palette, pin types and validation from: registry headers merged with the
 * unsaved content of every open tab of the kinds each catalog reads. Each is
 * rebuilt when the registry epoch advances or a document of those kinds
 * changes, so an edit in another open Class tab reaches the palette at once,
 * while Scene, Material or other edits leave the class catalogs alone. The
 * header-derived Class, Function Library and Scene parts follow the registry
 * only; an edit lays its open tabs over them without parsing a header again.
 */
export function useGraphPanelCatalogs() {
  const { loadAssetDocument } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const sceneDocumentsOpen = useOpenDocumentsOfKinds(SCENE_KINDS);
  const interfaceDocuments = useOpenDocumentsOfKinds(INTERFACE_KINDS);
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const inputDocuments = useOpenDocumentsOfKinds(INPUT_KINDS);
  const dataDocuments = useOpenDocumentsOfKinds(DATA_KINDS);
  const saveGameDocuments = useOpenDocumentsOfKinds(SAVE_GAME_KINDS);
  const saveGameGuid = projectDocument?.settings.saveGame?.definitionGuid;
  const saveGameAssets = useMemo(() => {
    void registryEpoch;
    const asset = saveGameGuid ? assetRegistry?.getByGuid(saveGameGuid) : undefined;
    return asset?.header.type === "SaveGame" ? [asset] : [];
  }, [saveGameGuid, assetRegistry, registryEpoch]);
  const openSaveDefinition = saveGameDocuments.find((doc) => doc.ref.path === saveGameAssets[0]?.path);
  const [loadedSaveDefinition, setLoadedSaveDefinition] = useState<{
    assets: typeof saveGameAssets; documents: typeof saveGameDocuments; definition?: SaveGameDefinition;
  }>();
  useEffect(() => {
    if (openSaveDefinition || !saveGameAssets.length) return;
    let canceled = false;
    void loadDefaultSaveGameDefinition(saveGameGuid, saveGameAssets, saveGameDocuments, loadAssetDocument).then((definition) => {
      if (!canceled) setLoadedSaveDefinition({ assets: saveGameAssets, documents: saveGameDocuments, definition });
    });
    return () => { canceled = true; };
  }, [saveGameGuid, saveGameAssets, saveGameDocuments, openSaveDefinition, loadAssetDocument]);
  const saveGameDefinition = useMemo(
    () => openSaveDefinition
      ? defaultSaveGameDefinition(saveGameGuid, saveGameAssets, saveGameDocuments)
      : loadedSaveDefinition?.assets === saveGameAssets && loadedSaveDefinition.documents === saveGameDocuments ? loadedSaveDefinition.definition : undefined,
    [openSaveDefinition, saveGameGuid, saveGameAssets, saveGameDocuments, loadedSaveDefinition],
  );
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);

  const parentOf = useMemo(() => {
    void registryEpoch;
    return classParentLookup(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  // Header-derived parts follow the registry; an edit lays the open tabs over them.
  const otherClassGraphs = useClassGraphs();
  const functionLibraryHeaders = useMemo(() => {
    void registryEpoch;
    return collectFunctionLibraryHeaders({
      assets: assetRegistry?.list() ?? [],
      parentOf,
      classIdForPath: classIdForGraphPath,
    });
  }, [assetRegistry, parentOf, registryEpoch]);
  const functionLibraries = useMemo(
    () => withOpenFunctionLibraries(functionLibraryHeaders, {
      openDocuments: classDocuments,
      parentOf,
      classIdForPath: classIdForGraphPath,
    }),
    [classDocuments, functionLibraryHeaders, parentOf],
  );
  // Subsystems read only which Classes are open, never their content.
  const openGraphPaths = classDocuments
    .filter((doc) => doc.ref.kind === "graph")
    .map((doc) => doc.ref.path)
    .join("\n");
  const subsystemClasses = useMemo(() => {
    void registryEpoch;
    return collectSubsystemClassesForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: openGraphPaths ? openGraphPaths.split("\n").map((path) => ({ ref: { kind: "graph", path } })) : [],
      parentOf,
      classIdForPath: classIdForGraphPath,
    });
  }, [assetRegistry, openGraphPaths, parentOf, registryEpoch]);
  const sceneHeaders = useMemo(() => {
    void registryEpoch;
    return collectSceneHeadersForPalette(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  // Kept while every Scene keeps its name, actor names and component lists,
  // so a transform scrub or a Level Script edit leaves the palette alone.
  const sceneDocumentsRef = useRef<PaletteSceneDocument[]>([]);
  const sceneDocuments = useMemo(() => {
    void registryEpoch;
    const next = withOpenScenesForPalette(
      sceneHeaders,
      sceneDocumentsOpen,
      (path) => assetRegistry?.getByPath(path)?.header.guid,
    );
    if (samePaletteScenes(sceneDocumentsRef.current, next)) return sceneDocumentsRef.current;
    sceneDocumentsRef.current = next;
    return next;
  }, [assetRegistry, registryEpoch, sceneDocumentsOpen, sceneHeaders]);
  const scriptInterfaces = useMemo(() => {
    void registryEpoch;
    return collectScriptInterfacesForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: interfaceDocuments,
    });
  }, [assetRegistry, interfaceDocuments, registryEpoch]);
  const typeAssets = useMemo(() => {
    void registryEpoch;
    return collectGraphTypeAssets({
      assets: assetRegistry?.list() ?? [],
      openDocuments: typeDocuments,
    });
  }, [assetRegistry, registryEpoch, typeDocuments]);
  const typeSchemas = useMemo(
    () => typeSchemasFromGraphAssets(typeAssets),
    [typeAssets],
  );
  // A Save Game linked to a Data Definition takes its fields from it, so editing the Data Definition updates these nodes.
  const resolvedSaveGameDefinition = useMemo(() => {
    if (!saveGameDefinition) return undefined;
    try { return resolveSaveGameDefinition(saveGameDefinition, typeSchemas).definition; }
    catch { return undefined; }
  }, [saveGameDefinition, typeSchemas]);
  const hierarchy = useMemo(
    () => classHierarchyFromParentOf(parentOf),
    [parentOf],
  );
  const inputAssets = useMemo(() => {
    void registryEpoch;
    return inputAssetCatalog(assetRegistry?.list() ?? [], inputDocuments);
  }, [assetRegistry, inputDocuments, registryEpoch]);
  const materialDomains = useMemo(() => {
    void registryEpoch;
    return materialDomainsFromAssets(
      assetRegistry?.list() ?? [],
      materialDocuments,
    );
  }, [assetRegistry, materialDocuments, registryEpoch]);
  const dataAssets = useMemo(() => {
    void registryEpoch;
    return collectDataGraphAssets(assetRegistry?.list() ?? [], dataDocuments);
  }, [assetRegistry, dataDocuments, registryEpoch]);
  // Timeline Assets and the clips bound to them; open Scenes, Scene Layers and clip assets, saved or not, win.
  // An open Scene or Scene Layer counts only through its clip list, so other
  // Scene edits skip the index; it is kept by value, so a clip edit that
  // leaves every clip's name and events alone keeps the palette.
  const clipDocuments = useOpenDocumentsOfKinds(CLIP_DOCUMENT_KINDS);
  const clipSourcesRef = useRef<ClipSource[]>([]);
  const clipSources = useMemo(() => {
    const next = clipDocuments.map(clipSource);
    if (sameClipSources(clipSourcesRef.current, next)) return clipSourcesRef.current;
    clipSourcesRef.current = next;
    return next;
  }, [clipDocuments]);
  const timelineSignature = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    return JSON.stringify(timelineScriptAssets(assets, projectTimelineClips(assets, clipSources)));
  }, [assetRegistry, clipSources, registryEpoch]);
  const timelineAssets = useMemo(() => JSON.parse(timelineSignature) as TimelineScriptAsset[], [timelineSignature]);

  return {
    parentOf,
    otherClassGraphs,
    functionLibraries,
    subsystemClasses,
    sceneDocuments,
    scriptInterfaces,
    typeAssets,
    typeSchemas,
    hierarchy,
    inputAssets,
    saveGameDefinition: resolvedSaveGameDefinition,
    materialDomains,
    dataAssets,
    timelineAssets,
  };
}

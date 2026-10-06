import { useEffect, useMemo, useState } from "react";
import type { SaveGameDefinition } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import {
  classParentLookup,
  materialDomainsFromAssets,
} from "../lib/content-browser-helpers";
import { inputAssetCatalog } from "../lib/input-asset-catalog";
import { collectDataGraphAssets } from "../lib/data-graph";
import {
  collectClassGraphsForPalette,
  collectFunctionLibrariesForPalette,
  collectGraphTypeAssets,
  collectSceneDocumentsForPalette,
  collectScriptInterfacesForPalette,
  collectSubsystemClassesForPalette,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import { classHierarchyFromParentOf } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { defaultSaveGameDefinition, loadDefaultSaveGameDefinition } from "../lib/save-game-catalog";

const CLASS_KINDS = ["graph"] as const;
const SCENE_KINDS = ["scene"] as const;
const INTERFACE_KINDS = ["script-interface"] as const;
const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;
const INPUT_KINDS = ["input-action", "input-axis"] as const;
const DATA_KINDS = ["data-tree"] as const;
const SAVE_GAME_KINDS = ["save-game"] as const;

/**
 * The project-wide catalogs a Class or Animation Graph panel builds its
 * palette, pin types and validation from: registry headers merged with the
 * unsaved content of every open tab of the kinds each catalog reads. Each is
 * rebuilt when the registry epoch advances or a document of those kinds
 * changes, so an edit in another open Class tab reaches the palette at once,
 * while Scene, Material or other edits leave the class catalogs alone.
 */
export function useGraphPanelCatalogs() {
  const { assetRegistry, registryEpoch, projectDocument, loadAssetDocument } = useDocuments();
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
    return (assetRegistry?.list() ?? []).filter((asset) => asset.header.guid === saveGameGuid && asset.header.type === "SaveGame");
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
  const saveGameDefinition = openSaveDefinition
    ? defaultSaveGameDefinition(saveGameGuid, saveGameAssets, saveGameDocuments)
    : loadedSaveDefinition?.assets === saveGameAssets && loadedSaveDefinition.documents === saveGameDocuments ? loadedSaveDefinition.definition : undefined;
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);

  const parentOf = useMemo(() => {
    void registryEpoch;
    return classParentLookup(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
  const otherClassGraphs = useMemo(() => {
    void registryEpoch;
    return collectClassGraphsForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: classDocuments,
      classIdForPath: classIdForGraphPath,
    });
  }, [assetRegistry, classDocuments, registryEpoch]);
  const functionLibraries = useMemo(() => {
    void registryEpoch;
    return collectFunctionLibrariesForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: classDocuments,
      parentOf,
      classIdForPath: classIdForGraphPath,
    });
  }, [assetRegistry, classDocuments, parentOf, registryEpoch]);
  const subsystemClasses = useMemo(() => {
    void registryEpoch;
    return collectSubsystemClassesForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: classDocuments,
      parentOf,
      classIdForPath: classIdForGraphPath,
    });
  }, [assetRegistry, classDocuments, parentOf, registryEpoch]);
  const sceneDocuments = useMemo(() => {
    void registryEpoch;
    return collectSceneDocumentsForPalette({
      assets: assetRegistry?.list() ?? [],
      openDocuments: sceneDocumentsOpen,
    });
  }, [assetRegistry, registryEpoch, sceneDocumentsOpen]);
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
    saveGameDefinition,
    materialDomains,
    dataAssets,
  };
}

import { useMemo } from "react";
import { isEditorGraphHost } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { subclassClassEntries } from "../lib/component-property-rows";
import {
  fontAssetHasFacetype,
  fontAssetHasMsdfJson,
  fontAssetHasMsdfPng,
} from "../lib/play-fonts";
import { collectEnumMemberNames } from "../lib/graph-inspector";
import { classIdFromClassAsset, classParentLookup } from "../lib/content-browser-helpers";
import {
  collectGraphTypeAssets,
  typeAssetPickerEntries,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";
import { collectDataGraphAssets } from "../lib/data-graph";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;
const DATA_KINDS = ["data-tree"] as const;

/**
 * The registry and open-document catalogs the Inspector reads for the
 * document at `docPath`: its index entry and Class ancestry, picker and Class
 * lists, Data and type catalogs, and the asset lookups property rows use.
 */
export function useInspectorCatalogs(docPath: string | undefined) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const indexed = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).find((asset) => asset.path === docPath);
  }, [assetRegistry, docPath, registryEpoch]);
  const parentClass = indexed?.header.parentClass ?? null;
  const parentOf = useMemo(
    () => {
      void registryEpoch;
      return classParentLookup(assetRegistry?.list() ?? []);
    },
    [assetRegistry, registryEpoch],
  );
  const editorGraph = isEditorGraphHost({
    parentClass,
    parentOf,
    assetType: indexed?.header.type,
  });
  // Registry-derived pickers and class lists: rebuilt when the registry
  // changes, not on every edit of the inspected document.
  const registryViews = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    return {
      interfaceAssets: assets
        .filter((asset) => asset.header.type === "ScriptInterface")
        .map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
        })),
      pickerAssets: assets.map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      })),
      objectClassEntries: subclassClassEntries("Object", assets, { editorGraph }),
      projectClasses: assets
        .filter((asset) => asset.header.type === "Class")
        .map((asset) => ({
          id: classIdFromClassAsset(asset),
          name: asset.header.name,
          group: "Project",
          parentClass: asset.header.parentClass,
        })),
    };
  }, [assetRegistry, editorGraph, registryEpoch]);
  const { interfaceAssets, pickerAssets, objectClassEntries, projectClasses } = registryViews;
  // Other open tabs' unsaved content these catalogs read, by kind.
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const dataDocuments = useOpenDocumentsOfKinds(DATA_KINDS);
  const dataAssets = useMemo(() => {
    void registryEpoch;
    return collectDataGraphAssets(assetRegistry?.list() ?? [], dataDocuments);
  }, [assetRegistry, dataDocuments, registryEpoch]);
  // Open Enum tabs' unsaved members win over saved headers.
  const enumMembers = useMemo(() => {
    void registryEpoch;
    return collectEnumMemberNames(typeDocuments, assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch, typeDocuments]);
  const typeCatalog = useMemo(
    () => {
      void registryEpoch;
      return collectGraphTypeAssets({
        assets: assetRegistry?.list() ?? [],
        openDocuments: typeDocuments,
      });
    },
    [assetRegistry, registryEpoch, typeDocuments],
  );
  const typeSchemas = useMemo(
    () => typeSchemasFromGraphAssets(typeCatalog),
    [typeCatalog],
  );
  const typeAssets = typeAssetPickerEntries(typeCatalog);
  const assetLabel = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.name ??
      pickerAssets.find((asset) => asset.guid === guid)?.name
    );
  };
  const assetType = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.type ??
      pickerAssets.find((asset) => asset.guid === guid)?.type
    );
  };
  const fontHasFacetype = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasFacetype(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };
  const fontHasMsdfJson = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasMsdfJson(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };
  const fontHasMsdfPng = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasMsdfPng(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };
  return {
    indexed,
    parentClass,
    parentOf,
    editorGraph,
    interfaceAssets,
    pickerAssets,
    objectClassEntries,
    projectClasses,
    dataAssets,
    enumMembers,
    typeCatalog,
    typeSchemas,
    typeAssets,
    assetLabel,
    assetType,
    fontHasFacetype,
    fontHasMsdfJson,
    fontHasMsdfPng,
  };
}

export type InspectorCatalogs = ReturnType<typeof useInspectorCatalogs>;

import { useMemo } from "react";
import { useDocuments } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "./logic-graph-document";
import { subclassClassEntries } from "./component-property-rows";

const TYPE_KINDS = ["data-definition", "structure", "enum"] as const;

/** Live schema and picker indexes shared by Data Definition and Data Tree editors. */
export function useDataCatalog() {
  const { assetRegistry, registryEpoch } = useDocuments();
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const assets = useMemo(() => {
    void registryEpoch;
    return assetRegistry?.list() ?? [];
  }, [assetRegistry, registryEpoch]);
  const byGuid = useMemo(() => new Map(assets.map((asset) => [asset.header.guid, asset])), [assets]);
  const types = useMemo(() => collectGraphTypeAssets({ assets, openDocuments: typeDocuments }), [assets, typeDocuments]);
  const schemas = useMemo(() => typeSchemasFromGraphAssets(types), [types]);
  const enumMembers = useMemo(() => Object.fromEntries(types.enums.map((entry) => [entry.guid, entry.members.map((member) => member.name)])), [types]);
  const pickerAssets = useMemo(() => assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })), [assets]);
  const propertyAssets = useMemo(() => pickerAssets.map((entry) => ({ id: entry.guid, name: entry.name, type: entry.type })), [pickerAssets]);
  const classEntries = useMemo(() => subclassClassEntries("BObject", assets), [assets]);
  return useMemo(() => ({ assets, byGuid, types, schemas, enumMembers, pickerAssets, propertyAssets, classEntries }), [assets, byGuid, types, schemas, enumMembers, pickerAssets, propertyAssets, classEntries]);
}

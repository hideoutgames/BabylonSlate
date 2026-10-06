/* eslint-disable react-refresh/only-export-components -- context module */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { normalizeDataDefinitionAsset, type DataDefinitionField } from "@babylonslate/core";
import { reconcileDataDefinitionDefault, structInstanceDefaultWithSchema, validateDataDefinition } from "@babylonslate/scripting";
import type { PinListRow } from "@babylonslate/editor-kit";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useDataCatalog } from "../lib/use-data-catalog";

export const DATA_DEFINITION_FIELD_TYPES = ["bool", "int", "float", "string", "tag", "tagContainer", "enum", "vec2", "vec3", "vec4", "rotator", "quat", "color", "transform", "class", "asset", "struct"];

function useDataDefinitionState() {
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const catalog = useDataCatalog();
  const doc = documents.openDocuments.find(entry => entry.id === documentId);
  const definition = useMemo(() => normalizeDataDefinitionAsset(doc?.content ?? {}), [doc?.content]);
  const asset = catalog.assets.find(entry => entry.path === doc?.ref.path);
  const readOnly = Boolean(asset && documents.assetRegistry?.getRoot(asset.rootId)?.readOnly) || Boolean(doc && documents.sourceControl.isDocumentReadOnly(doc.ref.path));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = definition.fields.find(field => field.id === selectedId) ?? definition.fields[0];
  const issues = useMemo(() => validateDataDefinition(definition, catalog.schemas, asset?.header.guid), [definition, catalog.schemas, asset?.header.guid]);
  const recursive = issues.some(issue => issue.code === "recursive-schema");
  const projectedSelected = useMemo(() => selected && !recursive ? reconcileDataDefinitionDefault(selected, catalog.schemas) : selected, [selected, recursive, catalog.schemas]);
  const selectedDefault = useMemo(() => selected && !recursive ? structInstanceDefaultWithSchema([{ ...selected, defaultValue: undefined }], catalog.schemas) : undefined, [selected, recursive, catalog.schemas]);
  const typeAssets = useMemo(() => [
    ...catalog.types.dataDefinitions.filter(entry => entry.guid !== asset?.header.guid).map(entry => ({ guid: entry.guid, name: entry.name, type: "DataDefinition" })),
    ...catalog.types.enums.map(entry => ({ guid: entry.guid, name: entry.name, type: "Enum" })),
  ], [catalog.types, asset?.header.guid]);

  const commit = (fields: DataDefinitionField[], mergeKey?: string) => {
    if (readOnly || !doc) return;
    setError(null);
    void documents.applyAssetDocumentChange(documentId, { ...definition, fields }, mergeKey).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const patchSelected = (patch: Partial<DataDefinitionField>, mergeKey?: string) => {
    if (!selected) return;
    commit(definition.fields.map(field => field.id === selected.id ? { ...field, ...patch } : field), mergeKey);
  };
  const changeFields = (rows: PinListRow[]) => {
    if (readOnly) return;
    const current = new Map(definition.fields.map(field => [field.id, field]));
    const fields = rows.map(row => {
      const previous = current.get(row.id);
      const field: DataDefinitionField = {
        ...previous, id: row.id, name: row.name, typeId: row.type,
        typeClassId: row.typeClassId, container: row.container ?? "single",
        keyTypeId: row.keyTypeId, keyTypeClassId: row.keyTypeClassId,
      };
      if (!previous || previous.typeId !== field.typeId || previous.typeClassId !== field.typeClassId ||
        (previous.container ?? "single") !== field.container || previous.keyTypeId !== field.keyTypeId || previous.keyTypeClassId !== field.keyTypeClassId) {
        delete field.fields;
        delete field.keyFields;
        const defaults = structInstanceDefaultWithSchema([{ ...field, defaultValue: undefined }], catalog.schemas);
        Object.assign(field, defaults.schema[0], { defaultValue: defaults.values[field.name] });
        delete field.min;
        delete field.max;
      }
      return field;
    });
    const added = fields.find(field => !current.has(field.id));
    if (added) setSelectedId(added.id);
    commit(fields);
  };

  const changeSelectedType = (patch: Partial<DataDefinitionField>) => {
    if (!selected) return;
    changeFields(definition.fields.map(field => {
      const next = field.id === selected.id ? { ...field, ...patch } : field;
      return { ...next, type: next.typeId, defaultValue: undefined };
    }));
  };
  return { catalog, definition, readOnly, selected, setSelectedId, error, issues, recursive, projectedSelected, selectedDefault, typeAssets, commit, patchSelected, changeFields, changeSelectedType };
}

const DataDefinitionEditingContext = createContext<ReturnType<typeof useDataDefinitionState> | null>(null);

/** Field selection survives closing a dock while schema edits share document history. */
export function DataDefinitionEditingProvider({ children }: { children: ReactNode }) {
  const value = useDataDefinitionState();
  return <DataDefinitionEditingContext.Provider value={value}>{children}</DataDefinitionEditingContext.Provider>;
}

export function useDataDefinitionEditing() {
  const context = useContext(DataDefinitionEditingContext);
  if (!context) throw new Error("Data Definitions require their document provider");
  return context;
}

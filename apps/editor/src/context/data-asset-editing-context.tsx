import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { isDataSheetAsset, type DataSheetAsset, type DataSheetRow } from "@babylonslate/core";
import { reconcileDataRow, validateDataRow, validateDataSheet } from "@babylonslate/scripting";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useDataCatalog } from "../lib/use-data-catalog";

function useDataSheetState() {
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const { assetRegistry } = documents;
  const catalog = useDataCatalog();
  const { assets, byGuid, types, schemas } = catalog;
  const doc = documents.openDocuments.find((entry) => entry.id === documentId);
  const sheet = isDataSheetAsset(doc?.content) ? doc.content : null;
  const definition = types.dataDefinitions.find((entry) => entry.guid === sheet?.definitionGuid);
  const indexed = assets.find((asset) => asset.path === doc?.ref.path);
  const assetReadOnly = Boolean(indexed && assetRegistry?.getRoot(indexed.rootId)?.readOnly) || Boolean(doc && documents.sourceControl.isDocumentReadOnly(doc.ref.path));
  // Sharing this cache across the three docks avoids revalidating unchanged rows.
  const inspectRow = useMemo(() => {
    const cache = new WeakMap<DataSheetRow, {
      migration: ReturnType<typeof reconcileDataRow> | null;
      issues: ReturnType<typeof validateDataRow>;
    }>();
    return (row: DataSheetRow) => {
      let result = cache.get(row);
      if (!result) {
        result = {
          migration: definition ? reconcileDataRow(row, definition.guid, definition.fields, schemas) : null,
          issues: validateDataRow(row, definition?.guid ?? null, schemas, { assetTypeForGuid: (guid) => byGuid.get(guid)?.header.type }),
        };
        cache.set(row, result);
      }
      return result;
    };
  }, [definition, schemas, byGuid]);
  const rowInfo = useMemo(() => new Map(sheet?.rows.map((row) => [row.id, inspectRow(row)]) ?? []), [sheet?.rows, inspectRow]);
  const validation = useMemo(() => {
    const identities = new Set<string>();
    if (sheet?.rows.some((row) => {
      const invalid = !row.id.trim() || row.id.trim() !== row.id || identities.has(row.id);
      identities.add(row.id);
      return invalid;
    })) return validateDataSheet(sheet, schemas, { assetTypeForGuid: (guid) => byGuid.get(guid)?.header.type });
    const names = new Map<string, number>();
    for (const row of sheet?.rows ?? []) names.set(row.name.trim().toLocaleLowerCase(), (names.get(row.name.trim().toLocaleLowerCase()) ?? 0) + 1);
    return (sheet?.rows ?? []).flatMap((row) => {
      const issues = [...(rowInfo.get(row.id)?.issues ?? [])];
      if (!row.name.trim()) issues.push({ code: "row-name", rowId: row.id, path: "", severity: "error", message: "Row name cannot be empty." });
      else if ((names.get(row.name.trim().toLocaleLowerCase()) ?? 0) > 1) issues.push({ code: "row-name", rowId: row.id, path: "", severity: "error", message: "Row names must be unique." });
      return issues;
    });
  }, [sheet, rowInfo, schemas, byGuid]);
  const identityInvalid = validation.some((issue) => issue.code === "duplicate-row");
  const readOnly = assetReadOnly || identityInvalid;
  const [selectedRowId, select] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ rowId: string; path: string; sequence: number } | null>(null);
  const focusField = (rowId: string, path: string) => {
    select(rowId);
    for (const panel of ["data-sheet-rows", "data-sheet-values"]) {
      if (!documents.isDockWindowOpen(panel)) documents.toggleDockWindow(panel);
    }
    documents.activateDockPanel("data-sheet-values");
    setFocusRequest((previous) => ({ rowId, path, sequence: (previous?.sequence ?? 0) + 1 }));
  };
  const changeSheet = async (update: (current: DataSheetAsset) => DataSheetAsset, mergeKey?: string) => {
    if (identityInvalid) throw new Error("Rows need unique, non-empty IDs before this sheet can be edited.");
    if (assetReadOnly) throw new Error("This sheet is read-only or locked.");
    const current = documents.getOpenDocuments().find((entry) => entry.id === documentId)?.content;
    if (!isDataSheetAsset(current)) throw new Error("The sheet is no longer available.");
    const next = update(current);
    if (next === current) return;
    if (!await documents.applyAssetDocumentChange(documentId, { ...next }, mergeKey)) throw new Error("The sheet could not be edited. Check whether it is read-only or locked.");
  };
  return { documentId, documents, doc, sheet, definition, readOnly, identityInvalid, catalog, rowInfo, validation, selectedRowId, select, focusRequest, focusField, changeSheet };
}

const DataAssetEditingContext = createContext<ReturnType<typeof useDataSheetState> | null>(null);

/** Rows and edits belong to the sheet; selection and focus are workspace state. */
export function DataAssetEditingProvider({ children }: { children: ReactNode }) {
  const value = useDataSheetState();
  return <DataAssetEditingContext.Provider value={value}>{children}</DataAssetEditingContext.Provider>;
}

// Context modules intentionally export their consumer hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useDataAssetEditing() {
  const context = useContext(DataAssetEditingContext);
  if (!context) throw new Error("Data sheets require their document provider");
  return context;
}

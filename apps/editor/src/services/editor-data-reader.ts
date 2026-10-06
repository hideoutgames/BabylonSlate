import { RuntimeDataCatalog, type RuntimeDataApi } from "@babylonslate/runtime";
import type { DataAssetCatalogEntry } from "@babylonslate/core";
import type { useDocuments } from "../context/document-context";

type Host = Pick<ReturnType<typeof useDocuments>, "assetRegistry" | "getOpenDocuments">;
const kinds = new Set(["data-definition", "data-sheet", "structure", "enum"]);

/** Shared game read nodes also work in utilities and include live unsaved edits. */
export function createEditorDataReader(getHost: () => Host, isActive: () => boolean): RuntimeDataApi {
  let cached: RuntimeDataCatalog | undefined;
  let owner: Host["assetRegistry"];
  let generation = -1;
  let open: Array<{ id: string; content: unknown }> = [];
  const catalog = (): RuntimeDataCatalog | undefined => {
    if (!isActive()) return undefined;
    const host = getHost();
    const registry = host.assetRegistry;
    if (!registry) return undefined;
    const documents = host.getOpenDocuments().filter((doc) => kinds.has(doc.ref.kind));
    if (cached && owner === registry && generation === registry.generation && open.length === documents.length &&
      open.every((doc, index) => doc.id === documents[index]!.id && doc.content === documents[index]!.content)) return cached;
    const byPath = new Map(documents.map((doc) => [doc.ref.path, doc.content]));
    const entries: DataAssetCatalogEntry[] = [];
    for (const asset of registry.list()) {
      const type = asset.header.type;
      if (asset.placeholder || (type !== "DataDefinition" && type !== "DataSheet" && type !== "Structure" && type !== "Enum")) continue;
      entries.push({ guid: asset.header.guid, name: asset.header.name, type, payload: byPath.get(asset.path) ?? asset.header.payload });
    }
    owner = registry;
    generation = registry.generation;
    // Content objects are replaced by the canonical command/Undo layer.
    open = documents.map((doc) => ({ id: doc.id, content: doc.content }));
    cached = new RuntimeDataCatalog(entries);
    return cached;
  };
  return {
    readRow: (sheet, rowId, definition) => catalog()?.readRow(sheet, rowId, definition) ?? null,
    getSheetRows: (sheet, definition) => catalog()?.getSheetRows(sheet, definition) ?? [],
    hasRow: (sheet, rowId, definition) => catalog()?.hasRow(sheet, rowId, definition) ?? false,
    hasSheet: (sheet, definition) => catalog()?.hasSheet(sheet, definition) ?? false,
  };
}

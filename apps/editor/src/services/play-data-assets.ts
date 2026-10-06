import { isDataDefinitionAsset, isDataSheetAsset, type DataAssetCatalogEntry } from "@babylonslate/core";

type DataDocumentKind = "data-definition" | "data-sheet" | "structure" | "enum";
type IndexedDataAsset = {
  path: string;
  placeholder?: boolean;
  header: { guid: string; name: string; type: string; payload?: unknown };
};

/** Reuse canonical indexed records; only legacy/incomplete headers need file I/O. */
export async function collectPlayDataCatalog(
  assets: readonly IndexedDataAsset[],
  openDocuments: readonly { ref: { path: string; kind: string }; content: unknown }[],
  loadContent: (kind: DataDocumentKind, path: string) => Promise<unknown | null>,
): Promise<DataAssetCatalogEntry[]> {
  const open = new Map(openDocuments.map((doc) => [`${doc.ref.kind}:${doc.ref.path}`, doc.content]));
  const entries: DataAssetCatalogEntry[] = [];
  for (const asset of assets) {
    const type = asset.header.type;
    if (asset.placeholder || (type !== "DataDefinition" && type !== "DataSheet" && type !== "Structure" && type !== "Enum")) continue;
    const kind = type === "DataDefinition" ? "data-definition" : type === "DataSheet" ? "data-sheet" : type === "Structure" ? "structure" : "enum";
    const indexed = asset.header.payload;
    const hasIndexedData = type === "DataDefinition" ? isDataDefinitionAsset(indexed) : type === "DataSheet" && isDataSheetAsset(indexed);
    const payload = open.get(`${kind}:${asset.path}`) ?? (hasIndexedData ? indexed : await loadContent(kind, asset.path));
    if (payload) entries.push({ guid: asset.header.guid, type, name: asset.header.name, payload });
  }
  return entries;
}

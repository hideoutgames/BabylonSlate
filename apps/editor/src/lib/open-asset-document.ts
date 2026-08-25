import {
  documentId,
  documentKindForAssetType,
  labelFromPath,
  type AssetDocumentKind,
  type DocumentRef,
} from "@babylonslate/core";

export type AssetDocumentLookup = {
  path: string;
  header: { type: string };
};

export function assetDocumentOpenTarget(
  getByGuid: (guid: string) => AssetDocumentLookup | undefined,
  guid: string,
): { kind: AssetDocumentKind; path: string } | null {
  const trimmed = guid.trim();
  if (!trimmed) return null;
  const asset = getByGuid(trimmed);
  if (!asset?.path) return null;
  const kind = documentKindForAssetType(asset.header.type);
  if (!kind) return null;
  return { kind, path: asset.path };
}

export function canOpenAssetDocument(
  getByGuid: (guid: string) => AssetDocumentLookup | undefined,
  guid: string,
): boolean {
  return assetDocumentOpenTarget(getByGuid, guid) !== null;
}

export async function openOrFocusAssetDocument(options: {
  guid: string;
  getByGuid: (guid: string) => AssetDocumentLookup | undefined;
  openDocumentIds: ReadonlySet<string> | readonly string[];
  setActiveDocument: (id: string) => void;
  openDocument: (ref: DocumentRef) => Promise<void>;
}): Promise<void> {
  const target = assetDocumentOpenTarget(options.getByGuid, options.guid);
  if (!target) return;
  const id = documentId(target);
  const openIds = Array.isArray(options.openDocumentIds)
    ? options.openDocumentIds
    : [...options.openDocumentIds];
  if (openIds.includes(id)) {
    options.setActiveDocument(id);
    return;
  }
  await options.openDocument({
    kind: target.kind,
    path: target.path,
    label: labelFromPath(target.path),
  });
}

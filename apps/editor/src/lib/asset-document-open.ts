import {
  createDocumentRef,
  documentKindForAssetType,
  type DocumentRef,
} from "@babylonslate/core";
import type { AssetRegistry } from "@babylonslate/assets";

export type AssetDocumentOpener = {
  /** Whether the guid resolves to an asset with a document tab. */
  canOpenAsset: (guid: string | null | undefined) => boolean;
  /** Opens the asset's document tab; no-op when the asset cannot open one. */
  openAsset: (guid: string) => Promise<void>;
};

/** Shared Scene Details / Inspector helpers for opening an asset row's document tab. */
export function assetDocumentOpen(
  assetRegistry: AssetRegistry | null | undefined,
  openDocument: (ref: DocumentRef) => Promise<void>,
): AssetDocumentOpener {
  const canOpenAsset = (guid: string | null | undefined) => {
    const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
    return Boolean(asset?.path && documentKindForAssetType(asset.header.type));
  };
  const openAsset = async (guid: string) => {
    const asset = assetRegistry?.getByGuid(guid);
    const kind = asset ? documentKindForAssetType(asset.header.type) : null;
    if (!asset?.path || !kind) return;
    await openDocument(
      createDocumentRef(kind, asset.path, { name: asset.header.name }),
    );
  };
  return { canOpenAsset, openAsset };
}

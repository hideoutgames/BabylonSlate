import type { IndexedAsset } from "@babylonslate/assets";
import { assetTypeForDocumentKind, type DocumentRef } from "@babylonslate/core";
import { resolveTypeVisual } from "@babylonslate/editor-kit";
import { classParentLookup, visualForIndexedAsset } from "./content-browser-helpers";

/** Keep document navigation consistent with the Content Browser's asset identity. */
export function documentTypeVisual(ref: DocumentRef, assets: readonly IndexedAsset[]) {
  const indexed = assets.find((asset) => asset.path === ref.path);
  return indexed
    ? visualForIndexedAsset(indexed, classParentLookup(assets))
    : resolveTypeVisual({ assetType: assetTypeForDocumentKind(ref.kind) });
}

import type { AssetRegistry } from "@babylonslate/assets";
import { assetTypeForDocumentKind, type DocumentRef } from "@babylonslate/core";
import { resolveTypeVisual } from "@babylonslate/editor-kit";
import {
  classParentLookup,
  visualForIndexedAsset,
} from "./content-browser-helpers";

/** Share within a render; a new resolver observes in-place registry updates. */
export function createDocumentTypeVisualResolver(
  registry: AssetRegistry | null | undefined,
) {
  let parents: ReturnType<typeof classParentLookup> | undefined;
  const parentOf = (id: string) => {
    parents ??= classParentLookup(registry?.list() ?? []);
    return parents(id);
  };
  return (ref: DocumentRef) => {
    const indexed = registry?.getByPath(ref.path);
    return indexed
      ? visualForIndexedAsset(indexed, parentOf)
      : resolveTypeVisual({
          assetType:
            ref.kind === "content-browser"
              ? undefined
              : assetTypeForDocumentKind(ref.kind),
        });
  };
}

export type DocumentTypeVisualResolver = ReturnType<
  typeof createDocumentTypeVisualResolver
>;

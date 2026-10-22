import type { AssetRegistry } from "@haptic/assets";
import { assetTypeForDocumentKind, type DocumentRef } from "@haptic/core";
import { resolveTypeVisual } from "@haptic/editor-kit";
import {
  classParentLookup,
  visualForIndexedAsset,
} from "./content-browser-helpers";

/**
 * Caches class ancestry on first use, so a reparented Class needs a new
 * resolver: key it on `[assetRegistry, registryEpoch]`.
 */
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

import type { AssetRegistry } from "@haptic/assets";
import { assetTypeForDocumentKind, type DocumentRef } from "@haptic/core";
import { resolveTypeVisual } from "@haptic/editor-kit";
import {
  classParentLookup,
  visualForIndexedAsset,
} from "./content-browser-helpers";
import type { ExtensionAssetTypeDescriptor } from "./extension-asset-types";

/**
 * Caches class ancestry on first use, so a reparented Class needs a new
 * resolver: key it on `[assetRegistry, registryEpoch]`.
 */
export function createDocumentTypeVisualResolver(
  registry: AssetRegistry | null | undefined,
  /** The enabled extensions' asset types, for their tabs' icons. */
  extensionTypes: readonly ExtensionAssetTypeDescriptor[] = [],
) {
  let parents: ReturnType<typeof classParentLookup> | undefined;
  const parentOf = (id: string) => {
    parents ??= classParentLookup(registry?.list() ?? []);
    return parents(id);
  };
  return (ref: DocumentRef) => {
    const indexed = registry?.getByPath(ref.path);
    return indexed
      ? visualForIndexedAsset(indexed, parentOf, extensionTypes)
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

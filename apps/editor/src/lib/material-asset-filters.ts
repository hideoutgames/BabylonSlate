/**
 * Material asset type and domain predicates, the Material header meta, and the
 * picker filters that prefer an open document's domain over the saved header.
 * `content-browser-helpers.ts` re-exports the public names.
 */
import { isMaterialTextureAssetType } from "@haptic/core";
import { isEnvironmentTexturePayload } from "@haptic/assets";
import { normalizeMaterialInstanceDocument, parseMaterialDomain } from "@haptic/shader-graph";

/** Header payload fields Content Browser / pickers can read without loading the document. */
export function materialHeaderMeta(
  assetType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (assetType === "MaterialInstance") {
    const instance = normalizeMaterialInstanceDocument(payload);
    return { domain: instance.domain, parentGuid: instance.parentGuid };
  }
  if (assetType !== "Material") return undefined;
  return {
    domain: parseMaterialDomain(payload.domain),
  };
}

export function isMaterialSamplerTextureAsset(header: { type: string; payload?: unknown }): boolean {
  return isMaterialTextureAssetType(header.type) &&
    (header.type !== "Texture" || !isEnvironmentTexturePayload(header.payload));
}

/** Assets a Material slot accepts: authored Materials and their instances. */
export const MATERIAL_ASSET_TYPES = ["Material", "MaterialInstance"] as const;

export function isMaterialAssetType(type: string): boolean {
  return type === "Material" || type === "MaterialInstance";
}

function openMaterialDocumentFor(
  asset: { path: string; header: { type: string } },
  openDocuments: ReadonlyArray<{ ref: { kind: string; path: string }; content: unknown }>,
) {
  const kind = asset.header.type === "MaterialInstance" ? "material-instance" : "material";
  return openDocuments.find((entry) => entry.ref.kind === kind && entry.ref.path === asset.path);
}

export function isPostProcessMaterialAsset(asset: {
  header: { type: string; payload?: Record<string, unknown> };
}): boolean {
  return (
    isMaterialAssetType(asset.header.type) &&
    asset.header.payload?.domain === "postProcess"
  );
}

export function isParticleMaterialAsset(asset: {
  header: { type: string; payload?: Record<string, unknown> };
}): boolean {
  return (
    isMaterialAssetType(asset.header.type) &&
    asset.header.payload?.domain === "particle"
  );
}

export function isPostProcessMaterialForPicker(
  asset: {
    path: string;
    header: { type: string; payload?: Record<string, unknown> };
  },
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
): boolean {
  const open = openMaterialDocumentFor(asset, openDocuments);
  if (open && open.content && typeof open.content === "object") {
    return (open.content as { domain?: unknown }).domain === "postProcess";
  }
  return isPostProcessMaterialAsset(asset);
}

export function isParticleMaterialForPicker(
  asset: {
    path: string;
    header: { type: string; payload?: Record<string, unknown> };
  },
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
): boolean {
  const open = openMaterialDocumentFor(asset, openDocuments);
  if (open && open.content && typeof open.content === "object") {
    return (open.content as { domain?: unknown }).domain === "particle";
  }
  return isParticleMaterialAsset(asset);
}

export function materialDomainsFromAssets(
  assets: ReadonlyArray<{
    path: string;
    header: { guid: string; type: string; payload?: Record<string, unknown> };
  }>,
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }> = [],
): Record<string, string> {
  const domains: Record<string, string> = {};
  for (const asset of assets) {
    if (!isMaterialAssetType(asset.header.type)) continue;
    const open = openMaterialDocumentFor(asset, openDocuments);
    const domain =
      open && open.content && typeof open.content === "object"
        ? (open.content as { domain?: unknown }).domain
        : asset.header.payload?.domain;
    if (typeof domain === "string" && domain.length > 0) {
      domains[asset.header.guid] = domain;
    }
  }
  return domains;
}

export function filterInspectorPinPickerAssets<
  T extends { guid: string; type: string },
>(
  assets: readonly T[],
  indexed: ReadonlyArray<{
    path: string;
    header: { guid: string; type: string; payload?: Record<string, unknown> };
  }>,
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>,
  options: { nodeType: string },
): T[] {
  if (
    options.nodeType !== "scene-layer.registerPostProcess" &&
    options.nodeType !== "scene-layer.unregisterPostProcess"
  ) {
    return [...assets];
  }
  return assets.filter((entry) => {
    const match = indexed.find((asset) => asset.header.guid === entry.guid);
    return match ? isPostProcessMaterialForPicker(match, openDocuments) : false;
  });
}

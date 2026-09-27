import { normalizeRenderTargetTexturePayload } from "@babylonslate/core";

/** Header dependencies keep live sampler outputs reachable in Play and export. */
export function renderTargetAssetDependencies(assetType: string, payload: unknown): string[] {
  if (assetType !== "RenderTargetTexture") return [];
  const guid = normalizeRenderTargetTexturePayload(payload).renderTargetGuid;
  return guid ? [guid] : [];
}

/** Applies to a header payload or a document chunk during cross-project import. */
export function remapRenderTargetPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType !== "RenderTargetTexture") return payload;
  const target = normalizeRenderTargetTexturePayload(payload).renderTargetGuid;
  return { ...payload, renderTargetGuid: target ? remap.get(target) ?? target : null };
}

import { normalizeRenderTargetTexturePayload } from "@babylonslate/core";

/** Header dependencies keep live sampler outputs reachable in Play and export. */
export function renderTargetAssetDependencies(assetType: string, payload: unknown): string[] {
  if (assetType !== "RenderTargetTexture") return [];
  const guid = normalizeRenderTargetTexturePayload(payload).renderTargetGuid;
  return guid ? [guid] : [];
}

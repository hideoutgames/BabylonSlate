import { publicAssetUrl } from "./branding";

/** Basis encode worker under Vite `BASE_URL` (GitHub Pages `/BabylonSlate/`). */
export function editorEncodeWorkerUrl(): string {
  return publicAssetUrl("basis/encode-worker.js");
}

/** Self-hosted KTX2 transcoder directory, always slash-terminated. */
export function editorKtx2PublicBase(): string {
  const base = publicAssetUrl("ktx2/");
  return base.endsWith("/") ? base : `${base}/`;
}

/** Self-hosted Draco glTF decoder directory, always slash-terminated. */
export function editorDracoPublicBase(): string {
  const base = publicAssetUrl("draco/");
  return base.endsWith("/") ? base : `${base}/`;
}

/** Self-hosted meshopt glTF decoder directory, always slash-terminated. */
export function editorMeshoptPublicBase(): string {
  const base = publicAssetUrl("meshopt/");
  return base.endsWith("/") ? base : `${base}/`;
}

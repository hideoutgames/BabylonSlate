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

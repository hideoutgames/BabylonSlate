/**
 * Some browsers (Safari and WKWebView among them) read an anchor download's
 * blob URL after the click returns, so the URL is released later.
 */
const DOWNLOAD_URL_LIFETIME_MS = 40_000;

/** Saves `blob` as `fileName` through a temporary anchor download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
}

/**
 * Saves zip bytes as `fileName`: exactly the view's bytes, even when it shares
 * a larger buffer, without an extra copy of a large Export Game archive. Every
 * producer is fflate output on a plain `ArrayBuffer`; a `SharedArrayBuffer`
 * view would make `Blob` throw.
 */
export function downloadZipArchive(bytes: Uint8Array, fileName: string): void {
  downloadBlob(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
    fileName,
  );
}

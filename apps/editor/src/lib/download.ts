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

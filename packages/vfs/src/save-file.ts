import {
  BabylonSlateFileExport,
  type BabylonSlateFileExportPlugin,
} from "./capacitor-file-export";
import { encodeBase64 } from "./capacitor-scoped-storage";
import {
  getElectronFileBridge,
  getHostPlatform,
  isAppleMobileOperatingSystem,
} from "./platform";

/** How `saveFile` delivered a file. */
export type SaveFileResult =
  /** The browser downloaded it (desktop and Android browsers, or Safari when it cannot share). */
  | "downloaded"
  /** A save dialog wrote it where the user chose (the desktop and Android apps). */
  | "saved"
  /** The user finished the share sheet, for example with Save to Files (the iOS app, iPhone and iPad Safari). */
  | "shared"
  /** The user closed the share sheet or save dialog without saving. Not an error. */
  | "cancelled";

/** Raw bytes per native `append`: a large Export Game archive never crosses the bridge as one string. */
export const NATIVE_EXPORT_CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * The desktop app's bound for one IPC transfer (`MAX_IPC_BYTES` in
 * apps/desktop). A larger file downloads, which Electron also saves through
 * its save dialog.
 */
export const ELECTRON_SAVE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Some browsers (Safari and WKWebView among them) read an anchor download's
 * blob URL after the click returns, so the URL is released later.
 */
const DOWNLOAD_URL_LIFETIME_MS = 40_000;

/**
 * Saves `data` as a file named `name` the way this host saves files: the
 * share sheet in the iOS app and on iPhone and iPad Safari, the system save
 * dialog in the Android and desktop apps, a download elsewhere.
 *
 * Safari shares only during a tap, so call this from the click handler before
 * any `await` when the bytes are ready; an export that finishes later falls
 * back to a download there.
 */
export function saveFile(name: string, data: Blob): Promise<SaveFileResult> {
  const host = getHostPlatform();
  if (host === "ios" || host === "android") {
    return exportThroughNativeShell(BabylonSlateFileExport, name, data);
  }
  if (host === "electron") return saveFromDesktop(name, data);
  if (isAppleMobileOperatingSystem()) {
    const file = shareableFile(name, data);
    if (file) return shareFromBrowser(file, data);
  }
  downloadWithAnchor(name, data);
  return Promise.resolve("downloaded");
}

/**
 * Streams `data` to the native shell in base64 chunks of `chunkBytes`, then
 * waits for the share sheet or save dialog. A failed transfer discards the
 * native temporary file.
 */
export async function exportThroughNativeShell(
  plugin: BabylonSlateFileExportPlugin,
  name: string,
  data: Blob,
  chunkBytes = NATIVE_EXPORT_CHUNK_BYTES,
): Promise<SaveFileResult> {
  const { id } = await plugin.begin({
    name,
    mimeType: data.type || "application/octet-stream",
  });
  try {
    for (let offset = 0; offset < data.size; offset += chunkBytes) {
      const chunk = await data.slice(offset, offset + chunkBytes).arrayBuffer();
      await plugin.append({ id, data: encodeBase64(new Uint8Array(chunk)) });
    }
  } catch (error) {
    await plugin.discard({ id }).catch(() => undefined);
    throw error;
  }
  return (await plugin.finish({ id })).result;
}

async function saveFromDesktop(name: string, data: Blob): Promise<SaveFileResult> {
  const bridge = getElectronFileBridge();
  if (!bridge || data.size > ELECTRON_SAVE_MAX_BYTES) {
    downloadWithAnchor(name, data);
    return "downloaded";
  }
  return (await bridge.save(name, await data.arrayBuffer())) ? "saved" : "cancelled";
}

function shareableFile(name: string, data: Blob): File | null {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  ) {
    return null;
  }
  const file = new File([data], name, { type: data.type });
  return navigator.canShare({ files: [file] }) ? file : null;
}

/** Calls `navigator.share` synchronously, so a caller inside a tap keeps its user activation. */
async function shareFromBrowser(file: File, data: Blob): Promise<SaveFileResult> {
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "";
    if (name === "AbortError") return "cancelled";
    // The tap that started a slow export has expired; Safari still downloads.
    if (name === "NotAllowedError") {
      downloadWithAnchor(file.name, data);
      return "downloaded";
    }
    throw error;
  }
}

function downloadWithAnchor(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
}

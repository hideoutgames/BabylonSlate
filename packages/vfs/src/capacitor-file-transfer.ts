import type { PluginListenerHandle } from "@capacitor/core";
import type { ProjectFolderHandle } from "@haptic/core";
import {
  BabylonSlateScopedStorage,
  isScopedStorageError,
  ScopedStorageErrorCode,
  type BabylonSlateScopedStorageEvents,
  type BabylonSlateScopedStoragePlugin,
  type NativeTransferProgress,
} from "./capacitor-scoped-storage";
import { isAppOwnedFolder } from "./library-folders";
import {
  FileTransferError,
  type NativeFileTransfer,
  type NativeFileTransferRequest,
  type NativeFileTransferResponse,
} from "./native-file-transfer-port";
import { projectFolderName, projectRelativePath } from "./project-path";

type TransferPlugin = Pick<BabylonSlateScopedStoragePlugin, "transferFile" | "cancelTransfer" | "writeRandomObject"> &
  BabylonSlateScopedStorageEvents;

/** Where the Documents tier keeps projects, as `DocumentsStorageAdapter` and `readDocumentsRange` name it. */
const PROJECTS_ROOT = "BabylonSlate/projects";

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** A transfer's error as the caller acts on it: the plugin's codes, or the failure as it came (no network). */
function transferError(error: unknown): unknown {
  if (isScopedStorageError(error, ScopedStorageErrorCode.Mismatch)) {
    return new FileTransferError("transfer-mismatch", (error as Error).message, { cause: error });
  }
  if (isScopedStorageError(error, ScopedStorageErrorCode.Cancelled)) {
    return new FileTransferError("transfer-cancelled", "The transfer was cancelled.", { cause: error });
  }
  if (isScopedStorageError(error, ScopedStorageErrorCode.Unreachable)) {
    return new FileTransferError("transfer-refused", (error as Error).message, { cause: error });
  }
  return error;
}

/**
 * The native file transfer on iOS and Android, through the storage plugin's
 * `transferFile` (URLSession upload-from-file and download-to-file tasks;
 * `HttpURLConnection` streams). Only projects in app storage: a chosen
 * folder is refused (Integrated mode never runs in one), and so are the
 * app-owned library folders beside projects. `directory` is the Capacitor
 * directory app storage uses on this platform (`DOCUMENTS` on iOS, `DATA` on
 * Android).
 */
export function capacitorFileTransfer(directory: "DOCUMENTS" | "DATA", plugin: TransferPlugin = BabylonSlateScopedStorage): NativeFileTransfer {
  const progress = new Map<string, (bytes: number) => void>();
  let listening: Promise<PluginListenerHandle> | null = null;
  const listen = () =>
    (listening ??= plugin.addListener("transferProgress", (event: NativeTransferProgress) => progress.get(event.id)?.(event.bytes)));

  const nativePath = (folder: ProjectFolderHandle, path: string): string => {
    if (folder.tier !== "documents" || !folder.id.startsWith("documents:")) {
      throw new FileTransferError("transfer-refused", "Files are transferred only in projects in app storage.");
    }
    try {
      const name = projectFolderName(folder.id.slice("documents:".length));
      if (isAppOwnedFolder(name)) throw new Error(`${name} is not a project.`);
      return `${PROJECTS_ROOT}/${name}/${projectRelativePath(path)}`;
    } catch (error) {
      throw new FileTransferError("transfer-refused", error instanceof Error ? error.message : String(error), { cause: error });
    }
  };

  return {
    async transfer(folder: ProjectFolderHandle, request: NativeFileTransferRequest): Promise<NativeFileTransferResponse> {
      const path = nativePath(folder, request.path);
      const { signal } = request;
      if (signal?.aborted) throw new FileTransferError("transfer-cancelled", "The transfer was cancelled.");
      const id = newId();
      if (request.onProgress) {
        progress.set(id, request.onProgress);
        await listen();
      }
      const cancel = () => void plugin.cancelTransfer({ id }).catch(() => undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await plugin.transferFile({
          id,
          method: request.method,
          url: request.url,
          headers: request.headers,
          directory,
          path,
          ...(request.expected ? { expectedSize: request.expected.size, expectedSha256: request.expected.sha256 } : {}),
        });
      } catch (error) {
        throw transferError(error);
      } finally {
        signal?.removeEventListener("abort", cancel);
        progress.delete(id);
      }
    },
    async writeRandomObject(folder: ProjectFolderHandle, folderPath: string, size: number) {
      const { sha256 } = await plugin.writeRandomObject({ directory, path: nativePath(folder, folderPath), size }).catch((error: unknown) => {
        throw transferError(error);
      });
      return { path: `${folderPath}/${sha256}`, sha256 };
    },
  };
}

import type { ProjectFolderHandle } from "@haptic/core";
import { capacitorFileTransfer } from "./capacitor-file-transfer";
import {
  FileTransferError,
  type NativeFileTransfer,
  type NativeFileTransferRequest,
  type NativeFileTransferResponse,
} from "./native-file-transfer-port";
import {
  getElectronFileTransferBridge,
  getHostPlatform,
  type ElectronFileTransferBridge,
} from "./platform";

/** One per page: each holds the page's only progress listener on its bridge. */
let pageTransfer: NativeFileTransfer | null | undefined;

/**
 * The host's native file transfer: the storage plugin on iOS and Android,
 * the main process on desktop. Null on the web (and in an Electron shell
 * without the bridge), where transfers keep the whole-body `NativeHttp` path.
 * Every caller shares the page's one instance.
 */
export function createNativeFileTransfer(): NativeFileTransfer | null {
  if (pageTransfer !== undefined) return pageTransfer;
  const platform = getHostPlatform();
  const bridge = platform === "electron" ? getElectronFileTransferBridge() : null;
  pageTransfer = platform === "ios"
    ? capacitorFileTransfer("DOCUMENTS")
    : platform === "android"
      ? capacitorFileTransfer("DATA")
      : bridge
        ? electronFileTransfer(bridge)
        : null;
  return pageTransfer;
}

/**
 * The desktop transfer over `files:transfer`: the main process streams
 * between `net.fetch` and the window's open project, so no byte crosses IPC.
 * A transfer names its folder, which main checks is still the window's.
 */
export function electronFileTransfer(bridge: ElectronFileTransferBridge): NativeFileTransfer {
  const progress = new Map<string, (bytes: number) => void>();
  let unsubscribe: (() => void) | null = null;
  return {
    async transfer(folder: ProjectFolderHandle, request: NativeFileTransferRequest): Promise<NativeFileTransferResponse> {
      const { signal } = request;
      if (signal?.aborted) throw new FileTransferError("transfer-cancelled", "The transfer was cancelled.");
      const id = globalThis.crypto.randomUUID();
      if (request.onProgress) {
        unsubscribe ??= bridge.onProgress((transfer, bytes) => progress.get(transfer)?.(bytes));
        progress.set(id, request.onProgress);
      }
      const cancel = () => void bridge.cancel(id).catch(() => undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await bridge.transfer(folder.id, {
          id,
          method: request.method,
          url: request.url,
          headers: request.headers,
          path: request.path,
          ...(request.expected ? { expected: request.expected } : {}),
        });
        if ("error" in result) {
          throw result.errorCode ? new FileTransferError(result.errorCode, result.error) : new Error(result.error);
        }
        return result;
      } finally {
        signal?.removeEventListener("abort", cancel);
        progress.delete(id);
      }
    },
  };
}

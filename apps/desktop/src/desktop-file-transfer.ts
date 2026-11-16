import type { NodeStorageAdapter } from "@haptic/vfs/node";
import { nodeFileTransfer, type TransferFetch } from "@haptic/vfs/node-file-transfer";
import { FileTransferError, isFileTransferError, type FileTransferErrorCode } from "@haptic/vfs/native-file-transfer-port";

/** A `files:transfer` request, validated by `validateIpcArguments`; see `NativeFileTransferRequest`. */
export interface DesktopTransferRequest {
  id: string;
  method: "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  path: string;
  expected?: { size: number; sha256: string };
}

/** Electron carries only a rejected invoke's message, so a failure is answered as data, with its code. */
export type DesktopTransferResult =
  | { status: number; bytes: number; sha256: string }
  | { error: string; errorCode?: FileTransferErrorCode };

/**
 * `files:transfer` and `files:cancel`: streams a file between `net.fetch`
 * and the sending window's open project in the main process, so no byte
 * crosses IPC (Node's `fs` streams with `crypto` hashing, the download
 * staged beside its file and renamed once checked). Each editor document
 * runs and cancels only its own transfers, inside the folder its adapter has
 * bound (the renderer names it, and a different one is refused); closing or
 * reloading the document cancels them.
 */
export class DesktopFileTransfers {
  private readonly running = new Map<number, Map<string, AbortController>>();

  constructor(private readonly fetch: TransferFetch) {}

  async transfer(
    owner: number,
    storage: NodeStorageAdapter,
    folderId: string,
    request: DesktopTransferRequest,
    progress: (id: string, bytes: number) => void,
  ): Promise<DesktopTransferResult> {
    let transfers = this.running.get(owner);
    if (!transfers) this.running.set(owner, transfers = new Map());
    if (transfers.has(request.id)) return { error: "A transfer with this id is already running." };
    const controller = new AbortController();
    transfers.set(request.id, controller);
    try {
      const folder = storage.getCurrentFolder();
      if (!folder || folder.id !== folderId) throw new FileTransferError("transfer-refused", "The project folder is no longer open.");
      return await nodeFileTransfer(storage, this.fetch).transfer(folder, {
        method: request.method,
        url: request.url,
        headers: request.headers,
        path: request.path,
        ...(request.expected ? { expected: request.expected } : {}),
        signal: controller.signal,
        onProgress: (bytes) => progress(request.id, bytes),
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ...(isFileTransferError(error) ? { errorCode: error.code } : {}),
      };
    } finally {
      transfers.delete(request.id);
      if (transfers.size === 0 && this.running.get(owner) === transfers) this.running.delete(owner);
    }
  }

  cancel(owner: number, id: string): void {
    this.running.get(owner)?.get(id)?.abort();
  }

  /** A gone document's transfers stop with it. */
  releaseOwner(owner: number): void {
    for (const controller of this.running.get(owner)?.values() ?? []) controller.abort();
    this.running.delete(owner);
  }
}

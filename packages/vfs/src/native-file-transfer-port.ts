import type { ProjectFolderHandle } from "@haptic/core";

/**
 * One file streamed between a URL and a project file by the host itself, so
 * its bytes never cross into JavaScript (Git LFS objects).
 */
export interface NativeFileTransferRequest {
  /** `GET` downloads the response body into `path`; `PUT` sends the file at `path` as the body. */
  method: "GET" | "PUT";
  /** HTTPS only. Redirects are never followed: a 3xx is a failure, as `lfs:fetch` treats it. */
  url: string;
  /**
   * Sent exactly as given and never kept by the host: the caller decides
   * which credential (if any) goes to which origin.
   */
  headers: Record<string, string>;
  /** The project file, relative to the folder; its parent folder must exist. */
  path: string;
  /**
   * The file's size and SHA-256 (lowercase hex). A download is moved into
   * place only when its body matches (it is written to a temporary file
   * beside `path` first, removed on a mismatch); an upload is sent only when
   * the file matches. Either refuses with `transfer-mismatch`.
   */
  expected?: { size: number; sha256: string };
  /** Aborting cancels the host's request and removes a download's temporary file (`transfer-cancelled`). */
  signal?: AbortSignal;
  /** Body bytes moved so far, at most every `FILE_TRANSFER_PROGRESS_MS`. */
  onProgress?: (bytes: number) => void;
}

export interface NativeFileTransferResponse {
  status: number;
  /**
   * The body bytes sent or received and their SHA-256, computed by the host
   * as they streamed. A download whose status is not 2xx writes nothing and
   * answers 0 and `""`.
   */
  bytes: number;
  sha256: string;
}

/** How often, at most, a transfer reports its progress. */
export const FILE_TRANSFER_PROGRESS_MS = 100;

export type FileTransferErrorCode =
  /** The body or file did not match `expected`: nothing was committed or sent. */
  | "transfer-mismatch"
  /** The request's signal aborted; a download left no file. */
  | "transfer-cancelled"
  /** The folder or path is not one this host transfers into (a chosen folder, a path outside the project, a folder no longer open). */
  | "transfer-refused";

/** A transfer that failed for a reason the caller acts on. Other failures (no network, a reset connection) are plain errors. */
export class FileTransferError extends Error {
  readonly code: FileTransferErrorCode;

  constructor(code: FileTransferErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileTransferError";
    this.code = code;
  }
}

export function isFileTransferError(error: unknown, code?: FileTransferErrorCode): error is FileTransferError {
  const found = (error as { code?: unknown } | null)?.code;
  return typeof found === "string" && found.startsWith("transfer-") && (code === undefined || found === code);
}

/**
 * The host's native file transfer: iOS and Android through the storage
 * plugin (app storage only: a chosen folder is refused), the desktop main
 * process confined to the window's open project. Web and test mode have
 * none, and keep the whole-body `NativeHttp` path.
 */
export interface NativeFileTransfer {
  transfer(folder: ProjectFolderHandle, request: NativeFileTransferRequest): Promise<NativeFileTransferResponse>;
  /**
   * The Git benchmark's test objects: `size` random bytes written by the
   * host into a new file in `directory` (which must exist) named by their
   * SHA-256, so no object is ever built in JavaScript. iOS and Android only.
   */
  writeRandomObject?(folder: ProjectFolderHandle, directory: string, size: number): Promise<{ path: string; sha256: string }>;
}

/** A transfer for whichever folder `storage` has bound, refused once it has none. */
export interface FolderFileTransfer {
  transfer(request: NativeFileTransferRequest): Promise<NativeFileTransferResponse>;
  writeRandomObject?(directory: string, size: number): Promise<{ path: string; sha256: string }>;
}

/**
 * `transfer` limited to the folder `storage` has bound at each call: a
 * folder-bound storage view answers no folder once another is open, and the
 * transfer is then refused, as the view refuses its own calls.
 */
export function folderFileTransfer(
  transfer: NativeFileTransfer,
  storage: { getCurrentFolder(): ProjectFolderHandle | null },
): FolderFileTransfer {
  const folder = (): ProjectFolderHandle => {
    const current = storage.getCurrentFolder();
    if (!current) throw new FileTransferError("transfer-refused", "The project folder is no longer open.");
    return current;
  };
  const random = transfer.writeRandomObject?.bind(transfer);
  return {
    transfer: async (request) => transfer.transfer(folder(), request),
    ...(random ? { writeRandomObject: async (directory: string, size: number) => random(folder(), directory, size) } : {}),
  };
}

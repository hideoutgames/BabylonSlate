import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectFolderHandle } from "@haptic/core";
import type { NodeStorageAdapter } from "./node-adapter";
import { projectRelativePath } from "./project-path";
import {
  FILE_TRANSFER_PROGRESS_MS,
  FileTransferError,
  type NativeFileTransfer,
  type NativeFileTransferRequest,
  type NativeFileTransferResponse,
} from "./native-file-transfer-port";

/** `fetch` as the host gives it: Electron's `net.fetch` in the desktop main process, Node's in tests and tools. */
export type TransferFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FileTransferOptions {
  fetch: TransferFetch;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  /** Milliseconds between progress reports (default `FILE_TRANSFER_PROGRESS_MS`). */
  progressMs?: number;
}

/** Bytes read per step when hashing or writing random objects. */
const CHUNK_BYTES = 1024 * 1024;

function cancelled(cause?: unknown): FileTransferError {
  return new FileTransferError("transfer-cancelled", "The transfer was cancelled.", cause === undefined ? undefined : { cause });
}

function mismatch(what: string): FileTransferError {
  return new FileTransferError("transfer-mismatch", what);
}

function throttled(report: ((bytes: number) => void) | undefined, interval: number) {
  let last = -Infinity;
  return (bytes: number, final = false) => {
    if (!report) return;
    const now = performance.now();
    if (!final && now - last < interval) return;
    last = now;
    report(bytes);
  };
}

/** A file's size and SHA-256, read in bounded chunks. */
async function hashFile(file: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK_BYTES, signal })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function checkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FileTransferError("transfer-refused", "Not a transfer address.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new FileTransferError("transfer-refused", "Files are transferred over HTTPS only.");
  }
}

/**
 * Streams one file between `url` and `file` (an absolute path the caller has
 * already confined to its project): a download is written to a temporary
 * file beside it (`.haptic-<uuid>.tmp`, the name every staged write in a
 * project uses), hashed as it arrives, checked against `expected` and only
 * then renamed over `file`; anything else removes the temporary file. An
 * upload sends the file as a file-backed body whose length the transport
 * knows (no chunked framing: S3-style stores refuse it), after checking it
 * against `expected` in one hashing pass. Redirects are never followed and
 * no cookie is sent.
 */
export async function transferFile(
  file: string,
  request: Pick<NativeFileTransferRequest, "method" | "url" | "headers" | "expected">,
  options: FileTransferOptions,
): Promise<NativeFileTransferResponse> {
  checkUrl(request.url);
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const progress = throttled(options.onProgress, options.progressMs ?? FILE_TRANSFER_PROGRESS_MS);
  try {
    return request.method === "PUT"
      ? await upload(file, request, options, progress)
      : await download(file, request, options, progress);
  } catch (error) {
    if (signal?.aborted) throw cancelled(error);
    throw error;
  }
}

async function upload(
  file: string,
  request: Pick<NativeFileTransferRequest, "url" | "headers" | "expected">,
  { fetch, signal }: FileTransferOptions,
  progress: (bytes: number, final?: boolean) => void,
): Promise<NativeFileTransferResponse> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Not a file: ${file}`);
  const sent = await hashFile(file, signal);
  if (request.expected && (sent.bytes !== request.expected.size || sent.sha256 !== request.expected.sha256)) {
    throw mismatch("The file is not the object its name says.");
  }
  // Read lazily from disk as the request goes out; a change to the file after this fails the read.
  const body = await openAsBlob(file);
  const response = await fetch(request.url, {
    method: "PUT",
    headers: request.headers,
    body,
    redirect: "error",
    credentials: "omit",
    ...(signal ? { signal } : {}),
  });
  await response.body?.cancel();
  progress(sent.bytes, true);
  return { status: response.status, ...sent };
}

async function download(
  file: string,
  request: Pick<NativeFileTransferRequest, "url" | "headers" | "expected">,
  { fetch, signal }: FileTransferOptions,
  progress: (bytes: number, final?: boolean) => void,
): Promise<NativeFileTransferResponse> {
  const response = await fetch(request.url, {
    method: "GET",
    headers: request.headers,
    redirect: "error",
    credentials: "omit",
    ...(signal ? { signal } : {}),
  });
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel();
    return { status: response.status, bytes: 0, sha256: "" };
  }
  const staged = join(dirname(file), `.haptic-${randomUUID()}.tmp`);
  const handle = await open(staged, "wx");
  let committed = false;
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.write(value);
        bytes += value.byteLength;
        progress(bytes);
      }
    }
    await handle.sync();
    await handle.close();
    const sha256 = hash.digest("hex");
    if (request.expected && (bytes !== request.expected.size || sha256 !== request.expected.sha256)) {
      throw mismatch("The downloaded file arrived damaged.");
    }
    if (signal?.aborted) throw cancelled();
    await rename(staged, file);
    committed = true;
    progress(bytes, true);
    return { status: response.status, bytes, sha256 };
  } finally {
    if (!committed) {
      await handle.close().catch(() => undefined);
      await unlink(staged).catch(() => undefined);
    }
  }
}

/**
 * `size` random bytes in a new file in `directory`, named by their SHA-256,
 * written and hashed in bounded chunks.
 */
export async function writeRandomFile(directory: string, size: number): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid size.");
  const staged = join(directory, `.haptic-${randomUUID()}.tmp`);
  const handle = await open(staged, "wx");
  let committed = false;
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size));
    for (let written = 0; written < size; ) {
      const part = chunk.subarray(0, Math.min(chunk.byteLength, size - written));
      randomFillSync(part);
      hash.update(part);
      await handle.write(part);
      written += part.byteLength;
    }
    await handle.sync();
    await handle.close();
    const sha256 = hash.digest("hex");
    await rename(staged, join(directory, sha256));
    committed = true;
    return sha256;
  } finally {
    if (!committed) {
      await handle.close().catch(() => undefined);
      await unlink(staged).catch(() => undefined);
    }
  }
}

/**
 * The native file transfer over a Node storage adapter (the desktop main
 * process's per-window adapter, or a test's): only the folder it has bound,
 * and only paths inside it as the adapter resolves them (a link inside the
 * project may not lead out of it).
 */
export function nodeFileTransfer(storage: Pick<NodeStorageAdapter, "getCurrentFolder" | "filePath">, fetch: TransferFetch): NativeFileTransfer {
  const bound = (folder: ProjectFolderHandle) => {
    if (storage.getCurrentFolder()?.id !== folder.id) {
      throw new FileTransferError("transfer-refused", "The project folder is no longer open.");
    }
  };
  const confined = async (path: string): Promise<string> => {
    try {
      return await storage.filePath(projectRelativePath(path));
    } catch (error) {
      throw new FileTransferError("transfer-refused", error instanceof Error ? error.message : String(error), { cause: error });
    }
  };
  return {
    async transfer(folder, request) {
      bound(folder);
      const file = await confined(request.path);
      return transferFile(file, request, {
        fetch,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      });
    },
    async writeRandomObject(folder, directory, size) {
      bound(folder);
      const sha256 = await writeRandomFile(await confined(directory), size);
      return { path: `${directory}/${sha256}`, sha256 };
    },
  };
}

import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, stat, unlink, type FileHandle } from "node:fs/promises";
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

/** What a transfer asks of `TransferRequest`: never follow a redirect, send no cookie or credential of the session, keep no cache. */
export interface TransferRequestOptions {
  method: "GET" | "PUT";
  url: string;
  redirect: "error";
  credentials: "omit";
  cache: "no-store";
}

/**
 * The part of Electron's `net.request` `ClientRequest` a transfer uses.
 * Electron refuses a `Content-Length` (or any framing) header from the app
 * (`net::ERR_INVALID_ARGUMENT`); left non-chunked, as a transfer leaves it,
 * it sends the body with its length.
 */
export interface TransferClientRequest {
  setHeader(name: string, value: string): void;
  /** `callback` runs once the chunk is handed to the network layer: the next is written only then. */
  write(chunk: Buffer, encoding: undefined, callback: () => void): void;
  end(): void;
  abort(): void;
  /**
   * `response` (a `TransferIncomingMessage`) and `error` (an `Error`). One
   * loose signature, so Electron's own overloaded `ClientRequest` fits it.
   */
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** The part of Electron's `IncomingMessage` a transfer uses: a readable stream it pauses while it writes. */
export interface TransferIncomingMessage {
  readonly statusCode: number;
  /** `data` (a `Buffer`), `end` and `error` (an `Error`). */
  on(event: string, listener: (...args: never[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

/** `net.request` in the desktop main process; a stand-in over Node's `http` in tests. */
export type TransferRequest = (options: TransferRequestOptions) => TransferClientRequest;

export interface FileTransferOptions {
  request: TransferRequest;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  /** Milliseconds between progress reports (default `FILE_TRANSFER_PROGRESS_MS`). */
  progressMs?: number;
}

/** Bytes read per step when hashing, uploading or writing random objects. */
const CHUNK_BYTES = 1024 * 1024;
/** Framing the transport owns; Electron refuses an app's. */
const TRANSPORT_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "host", "keep-alive", "upgrade", "te", "trailer"]);

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
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK_BYTES, ...(signal ? { signal } : {}) })) {
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
 * One request's life: started with the caller's headers (less framing),
 * aborted when `signal` aborts (the work then rejects as cancelled at once),
 * failed by its `error` event.
 */
class Exchange {
  readonly request: TransferClientRequest;
  /** Rejects on an abort or a request error; never resolves. */
  readonly failed: Promise<never>;
  private fail: (error: unknown) => void = () => {};
  private readonly onAbort = () => {
    this.request.abort();
    this.fail(cancelled());
  };

  constructor(
    transport: TransferRequest,
    method: "GET" | "PUT",
    url: string,
    headers: Record<string, string>,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.request = transport({ method, url, redirect: "error", credentials: "omit", cache: "no-store" });
    this.failed = new Promise<never>((_resolve, reject) => (this.fail = reject));
    this.failed.catch(() => undefined);
    for (const [name, value] of Object.entries(headers)) {
      if (!TRANSPORT_HEADERS.has(name.toLowerCase())) this.request.setHeader(name, value);
    }
    this.request.on("error", (error: Error) => this.fail(signal?.aborted ? cancelled(error) : error));
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** The response, once the body (if any) is sent: each chunk written only after the last one's callback. */
  async respond(body: AsyncIterable<Buffer> | null, sent?: (bytes: number) => void): Promise<TransferIncomingMessage> {
    const response = new Promise<TransferIncomingMessage>((resolve) => this.request.on("response", (response: TransferIncomingMessage) => resolve(response)));
    const send = async () => {
      let bytes = 0;
      if (body) {
        for await (const chunk of body) {
          await Promise.race([new Promise<void>((done) => this.request.write(chunk, undefined, done)), this.failed]);
          bytes += chunk.byteLength;
          sent?.(bytes);
        }
      }
      this.request.end();
    };
    const sending = send();
    // A failure that ends the race first still settles the send; its own failure is then moot.
    sending.catch(() => undefined);
    await Promise.race([sending, this.failed]);
    return Promise.race([response, this.failed]);
  }

  close(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

/**
 * Streams one file between `url` and `file` (an absolute path the caller has
 * already confined to its project) through `options.request` (Electron's
 * `net.request` in the desktop main process): a download is written to a
 * temporary file beside it (`.haptic-<uuid>.tmp`, the name every staged
 * write in a project uses) as it arrives, the response paused while each
 * chunk is written and hashed, checked against `expected` and only then
 * renamed over `file`; anything else removes the temporary file. An upload
 * is checked against `expected` in one hashing pass, then read again and
 * written chunk by chunk, each once the last was taken; the request stays
 * non-chunked, so it goes with its length (S3-style stores refuse chunked
 * uploads; Electron holds such a body in the main process until it is sent,
 * never in the renderer or IPC). Redirects are never followed and no
 * cookie, session credential or cache is used.
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
    if (signal?.aborted) throw error instanceof FileTransferError && error.code === "transfer-cancelled" ? error : cancelled(error);
    throw error;
  }
}

async function upload(
  file: string,
  request: Pick<NativeFileTransferRequest, "url" | "headers" | "expected">,
  options: FileTransferOptions,
  progress: (bytes: number, final?: boolean) => void,
): Promise<NativeFileTransferResponse> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Not a file: ${file}`);
  const sent = await hashFile(file, options.signal);
  if (request.expected && (sent.bytes !== request.expected.size || sent.sha256 !== request.expected.sha256)) {
    throw mismatch("The file is not the object its name says.");
  }
  const exchange = new Exchange(options.request, "PUT", request.url, request.headers, options.signal);
  try {
    const body = createReadStream(file, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer> & { destroy(): void };
    let response: TransferIncomingMessage;
    try {
      response = await exchange.respond(body, (bytes) => progress(bytes));
    } finally {
      body.destroy();
    }
    // The answer's body is not needed; it is read off so the request can finish. A connection that drops while
    // it is read fails nothing: the status is already in hand, and an unheard `error` would throw in main.
    response.on("error", () => undefined);
    response.resume();
    progress(sent.bytes, true);
    return { status: response.statusCode, ...sent };
  } finally {
    exchange.close();
  }
}

async function download(
  file: string,
  request: Pick<NativeFileTransferRequest, "url" | "headers" | "expected">,
  options: FileTransferOptions,
  progress: (bytes: number, final?: boolean) => void,
): Promise<NativeFileTransferResponse> {
  const exchange = new Exchange(options.request, "GET", request.url, request.headers, options.signal);
  try {
    const response = await exchange.respond(null);
    if (response.statusCode < 200 || response.statusCode > 299) {
      // An error body is never written; nothing more of it is wanted, nor the failure the abort reports on it.
      response.on("error", () => undefined);
      exchange.request.abort();
      return { status: response.statusCode, bytes: 0, sha256: "" };
    }
    const staged = join(dirname(file), `.haptic-${randomUUID()}.tmp`);
    let handle: FileHandle | null = null;
    let committed = false;
    try {
      handle = await open(staged, "wx");
      const output = handle;
      const hash = createHash("sha256");
      let bytes = 0;
      const received = new Promise<void>((resolve, reject) => {
        let writing = Promise.resolve();
        response.on("data", (chunk: Buffer) => {
          // Paused until the chunk is on disk, so no more of the body than a chunk is ever held.
          response.pause();
          writing = writing.then(async () => {
            hash.update(chunk);
            await output.write(chunk);
            bytes += chunk.byteLength;
            progress(bytes);
            response.resume();
          });
          writing.catch(reject);
        });
        response.on("end", () => void writing.then(resolve, reject));
        response.on("error", (error: Error) => reject(error));
      });
      received.catch(() => undefined);
      await Promise.race([received, exchange.failed]);
      await output.sync();
      await output.close();
      const sha256 = hash.digest("hex");
      if (request.expected && (bytes !== request.expected.size || sha256 !== request.expected.sha256)) {
        throw mismatch("The downloaded file arrived damaged.");
      }
      if (options.signal?.aborted) throw cancelled();
      await rename(staged, file);
      committed = true;
      progress(bytes, true);
      return { status: response.statusCode, bytes, sha256 };
    } catch (error) {
      exchange.request.abort();
      throw error;
    } finally {
      if (!committed && handle) {
        await handle.close().catch(() => undefined);
        await unlink(staged).catch(() => undefined);
      }
    }
  } finally {
    exchange.close();
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
export function nodeFileTransfer(storage: Pick<NodeStorageAdapter, "getCurrentFolder" | "filePath">, request: TransferRequest): NativeFileTransfer {
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
    async transfer(folder, transfer) {
      bound(folder);
      const file = await confined(transfer.path);
      return transferFile(file, transfer, {
        request,
        ...(transfer.signal ? { signal: transfer.signal } : {}),
        ...(transfer.onProgress ? { onProgress: transfer.onProgress } : {}),
      });
    },
    async writeRandomObject(folder, directory, size) {
      bound(folder);
      const sha256 = await writeRandomFile(await confined(directory), size);
      return { path: `${directory}/${sha256}`, sha256 };
    },
  };
}

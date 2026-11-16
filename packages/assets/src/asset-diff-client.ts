import type { AssetDiff, AssetVersionSource } from "./asset-diff";
import { AssetDiffError, type AssetDiffReplyMessage, type AssetDiffRequestMessage } from "./asset-diff-protocol";

export { AssetDiffError } from "./asset-diff-protocol";

/** The worker surface the client uses, so tests can stand in for a real Worker. */
export type AssetDiffWorkerHandle = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export interface AssetDiffRequest {
  path: string;
  base: AssetVersionSource;
  compare: AssetVersionSource;
  /** Aborting rejects the request; the worker stops asking for its reads. */
  signal?: AbortSignal;
}

interface Channel {
  post(message: AssetDiffRequestMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

interface Pending {
  request: AssetDiffRequest;
  resolve: (diff: AssetDiff) => void;
  reject: (error: unknown) => void;
}

/** A view of a whole, transferable buffer: moving it takes nothing else along. */
function wholeBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
}

function moduleWorker(): AssetDiffWorkerHandle | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./asset-diff-worker.ts", import.meta.url), { type: "module" });
}

/**
 * Asset diffs on a long-lived worker, which keeps decoded commit versions
 * between diffs; reads come back to the caller's sources on this thread.
 * Without `Worker` (unit tests) the same handler runs on this thread.
 */
export class AssetDiffClient {
  private channel: Promise<Channel> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly createWorker: () => AssetDiffWorkerHandle | null;

  constructor(options: { createWorker?: () => AssetDiffWorkerHandle | null } = {}) {
    this.createWorker = options.createWorker ?? moduleWorker;
  }

  diff(request: AssetDiffRequest): Promise<AssetDiff> {
    request.signal?.throwIfAborted();
    const id = (this.nextId += 1);
    return new Promise<AssetDiff>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        void this.open().then((channel) => channel.post({ type: "cancel", id }));
        reject(request.signal?.reason ?? new DOMException("Cancelled.", "AbortError"));
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      const settle = <T,>(done: (value: T) => void) => (value: T) => {
        request.signal?.removeEventListener("abort", abort);
        done(value);
      };
      this.pending.set(id, { request, resolve: settle(resolve), reject: settle(reject) });
      this.open().then(
        (channel) => channel.post({ type: "diff", id, path: request.path, base: { key: request.base.key }, compare: { key: request.compare.key } }),
        (error: unknown) => this.fail(id, error),
      );
    });
  }

  /** Ends the worker and its decoded versions; pending diffs reject. */
  dispose(): void {
    const channel = this.channel;
    this.channel = null;
    void channel?.then((open) => open.terminate(), () => undefined);
    for (const id of [...this.pending.keys()]) this.fail(id, new AssetDiffError("The diff was closed."));
  }

  private fail(id: number, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }

  private open(): Promise<Channel> {
    this.channel ??= this.connect();
    return this.channel;
  }

  private async connect(): Promise<Channel> {
    const worker = this.createWorker();
    if (worker) {
      worker.onmessage = (event: MessageEvent<AssetDiffReplyMessage>) => this.receive(event.data);
      worker.onerror = (event) => {
        // A broken worker takes its pending diffs with it; the next diff starts another.
        this.channel = null;
        worker.terminate();
        for (const id of [...this.pending.keys()]) this.fail(id, new AssetDiffError(event.message || "The diff worker failed."));
      };
      return { post: (message, transfer = []) => worker.postMessage(message, transfer), terminate: () => worker.terminate() };
    }
    const { createAssetDiffHandler } = await import("./asset-diff-protocol");
    const handle = createAssetDiffHandler((message) => queueMicrotask(() => this.receive(message)));
    return { post: (message) => queueMicrotask(() => handle(message)), terminate: () => undefined };
  }

  private receive(message: AssetDiffReplyMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    switch (message.type) {
      case "result":
        this.pending.delete(message.id);
        pending.resolve(message.diff);
        return;
      case "error":
        this.pending.delete(message.id);
        pending.reject(new AssetDiffError(message.message, message.code));
        return;
      case "read":
        void this.answerRead(message, pending.request);
        return;
    }
  }

  private async answerRead(message: Extract<AssetDiffReplyMessage, { type: "read" }>, request: AssetDiffRequest): Promise<void> {
    const source = message.side === "base" ? request.base : request.compare;
    let reply: AssetDiffRequestMessage;
    const transfer: Transferable[] = [];
    try {
      const bytes = message.blob ? await source.readBlob(message.blob.sha256, message.blob.byteLength) : await source.read();
      // Fresh bytes (the working copy's files) move to the worker as they are; a copy of others, so their holder's stay readable.
      const sent = bytes ? (source.owned && wholeBuffer(bytes) ? bytes : bytes.slice()) : null;
      if (sent) transfer.push(sent.buffer);
      reply = { type: "read-result", id: message.id, read: message.read, bytes: sent };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      reply = { type: "read-error", id: message.id, read: message.read, message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) };
    }
    if (!this.pending.has(message.id)) return;
    (await this.open()).post(reply, transfer);
  }
}

import type { EncodeFn } from "./encode-queue";
import { decodeSourceToRgba } from "./decode-source-rgba";
import {
  ENCODE_WORKER_DECODE_UNAVAILABLE,
  sourceEncodeTransferables,
  type EncodeWorkerReply,
  type SourceEncodeRequest,
} from "./encode-worker-protocol";
import type { TextureEncodeSettings } from "./texture-compression";

export interface WorkerEncodeOptions {
  /** Absolute or site-root URL to encode-worker.js (default `/basis/encode-worker.js`). */
  workerUrl?: string;
  /** Recycle underlying Worker after this many completed encodes. */
  recycleAfter?: number;
}

interface PendingEncode {
  resolve: (value: { ktx2: Uint8Array; wallMs: number }) => void;
  reject: (error: unknown) => void;
  source: Uint8Array;
  settings: TextureEncodeSettings;
  mime?: string;
}

/**
 * Browser EncodeFn backed by a dedicated Basis Worker (engineplan §3.5).
 * Transfers source bytes + MIME into the worker for decode/clamp; falls back
 * to main-thread Image.decode when the worker reports decode_unavailable.
 */
export function createWorkerEncodeFn(
  options: WorkerEncodeOptions = {},
): EncodeFn & { dispose: () => void; recycleCount: () => number } {
  const workerUrl = options.workerUrl ?? "/basis/encode-worker.js";
  const recycleAfter = options.recycleAfter ?? 5;
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  let completed = 0;
  let recycled = 0;
  const pending = new Map<number, PendingEncode>();

  const failPending = (error: unknown) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
    ready = null;
  };

  const postSourceEncode = (id: number, job: PendingEncode) => {
    const sourceCopy = job.source.slice();
    const message: SourceEncodeRequest = {
      type: "encode",
      id,
      source: sourceCopy.buffer,
      mime: job.mime,
      settings: job.settings,
    };
    worker!.postMessage(message, sourceEncodeTransferables(message));
  };

  const postRgbaEncode = (
    id: number,
    decoded: { rgba: Uint8Array; width: number; height: number },
    settings: TextureEncodeSettings,
  ) => {
    const rgbaCopy = decoded.rgba.slice();
    worker!.postMessage(
      {
        type: "encode",
        id,
        rgba: rgbaCopy.buffer,
        width: decoded.width,
        height: decoded.height,
        settings,
      },
      [rgbaCopy.buffer],
    );
  };

  const fallbackDecode = (id: number, job: PendingEncode) => {
    void decodeSourceToRgba(job.source, job.settings.maxDimension, job.mime)
      .then((decoded) => {
        if (!pending.has(id) || !worker) return;
        postRgbaEncode(id, decoded, job.settings);
      })
      .catch((error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(error);
      });
  };

  const ensureWorker = (): Promise<void> => {
    if (ready) return ready;
    worker = new Worker(workerUrl);
    ready = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const msg = event.data as EncodeWorkerReply;
        if (msg.type === "loaded") {
          resolve();
          return;
        }
        if (msg.type === "error" && msg.id == null) {
          const error = new Error(msg.error ?? "worker init failed");
          reject(error);
          failPending(error);
          return;
        }
        if (msg.type === "encoded" && msg.id != null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          entry.resolve({
            ktx2: new Uint8Array(msg.ktx2!),
            wallMs: msg.wallMs ?? 0,
          });
          return;
        }
        if (msg.type === ENCODE_WORKER_DECODE_UNAVAILABLE && msg.id != null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          fallbackDecode(msg.id, entry);
          return;
        }
        if (msg.type === "error" && msg.id != null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          entry.reject(new Error(msg.error ?? "encode failed"));
        }
      };
      worker!.addEventListener("message", onMessage);
      worker!.addEventListener("error", (err) => {
        const error = err.error ?? new Error("encode worker error");
        reject(error);
        failPending(error);
      });
      worker!.addEventListener("messageerror", () => {
        const error = new Error("encode worker messageerror");
        reject(error);
        failPending(error);
      });
      worker!.postMessage({ type: "init" });
    });
    return ready;
  };

  const maybeRecycle = async () => {
    completed += 1;
    if (completed < recycleAfter || !worker) return;
    if (pending.size > 0) return;
    completed = 0;
    recycled += 1;
    worker.terminate();
    worker = null;
    ready = null;
  };

  const encode: EncodeFn = async (
    source: Uint8Array,
    settings: TextureEncodeSettings,
    mime?: string,
  ) => {
    await ensureWorker();
    const id = nextId++;
    const result = await new Promise<{ ktx2: Uint8Array; wallMs: number }>(
      (resolve, reject) => {
        const job: PendingEncode = {
          resolve,
          reject,
          source,
          settings,
          mime,
        };
        pending.set(id, job);
        postSourceEncode(id, job);
      },
    );
    await maybeRecycle();
    return result;
  };

  return Object.assign(encode, {
    dispose: () => {
      failPending(new Error("encode worker disposed"));
    },
    recycleCount: () => recycled,
  });
}

/** True when a dedicated Worker can host encode (decode may still fall back). */
export function canUseWorkerEncode(): boolean {
  return typeof Worker !== "undefined";
}

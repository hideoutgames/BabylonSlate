import type { EncodeFn } from "./encode-queue";
import { decodeSourceToRgba } from "./decode-source-rgba";
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
}

/**
 * Browser EncodeFn backed by a dedicated Basis Worker (engineplan §3.5).
 * Decodes on the calling side (or inside worker via rgba payload) then encodes KTX2.
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

  const ensureWorker = (): Promise<void> => {
    if (ready) return ready;
    worker = new Worker(workerUrl);
    ready = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const msg = event.data as {
          type: string;
          id?: number;
          error?: string;
          ktx2?: ArrayBuffer;
          wallMs?: number;
        };
        if (msg.type === "loaded") {
          resolve();
          return;
        }
        if (msg.type === "error" && msg.id == null) {
          reject(new Error(msg.error ?? "worker init failed"));
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
        if (msg.type === "error" && msg.id != null) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          entry.reject(new Error(msg.error ?? "encode failed"));
        }
      };
      worker!.addEventListener("message", onMessage);
      worker!.addEventListener("error", (err) => {
        reject(err.error ?? new Error("encode worker error"));
      });
      worker!.postMessage({ type: "init" });
    });
    return ready;
  };

  const maybeRecycle = async () => {
    completed += 1;
    if (completed < recycleAfter || !worker) return;
    completed = 0;
    recycled += 1;
    for (const entry of pending.values()) {
      entry.reject(new Error("encode worker recycled"));
    }
    pending.clear();
    worker.terminate();
    worker = null;
    ready = null;
  };

  const encode: EncodeFn = async (
    source: Uint8Array,
    settings: TextureEncodeSettings,
  ) => {
    await ensureWorker();
    const decoded = await decodeSourceToRgba(source, settings.maxDimension);
    const id = nextId++;
    const result = await new Promise<{ ktx2: Uint8Array; wallMs: number }>(
      (resolve, reject) => {
        pending.set(id, { resolve, reject });
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
      },
    );
    await maybeRecycle();
    return result;
  };

  return Object.assign(encode, {
    dispose: () => {
      worker?.terminate();
      worker = null;
      ready = null;
      pending.clear();
    },
    recycleCount: () => recycled,
  });
}

/** True when dedicated Workers + OffscreenCanvas are available for encode. */
export function canUseWorkerEncode(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

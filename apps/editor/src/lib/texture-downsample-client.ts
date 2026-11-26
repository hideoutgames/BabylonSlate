import { decodeSourceToRgba, packRawRgbaTexture } from "@haptic/assets";
import type { TextureDownsampleRequest, TextureDownsampleResponse } from "./texture-downsample-worker";

/** Bounded LRU cache for downsampled HRGB raw-RGBA textures across scene opens / Play round-trips. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const IDLE_TERMINATE_MS = 30_000;
const MAX_WORKERS = 4;

type CacheEntry = {
  bytes: Uint8Array;
};

const downsampledCache = new Map<string, CacheEntry>();
let downsampledCacheBytes = 0;

function cacheGet(key: string): Uint8Array | undefined {
  const entry = downsampledCache.get(key);
  if (!entry) return undefined;
  downsampledCache.delete(key);
  downsampledCache.set(key, entry);
  return entry.bytes;
}

function cacheSet(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_CACHE_BYTES) return;
  const existing = downsampledCache.get(key);
  if (existing) {
    downsampledCacheBytes -= existing.bytes.byteLength;
    downsampledCache.delete(key);
  }
  while (downsampledCacheBytes + bytes.byteLength > MAX_CACHE_BYTES && downsampledCache.size > 0) {
    const oldestKey = downsampledCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = downsampledCache.get(oldestKey)!;
    downsampledCacheBytes -= oldest.bytes.byteLength;
    downsampledCache.delete(oldestKey);
  }
  downsampledCache.set(key, { bytes });
  downsampledCacheBytes += bytes.byteLength;
}

/** Test seam: clears the downsampled texture cache. */
export function clearDownsampledTextureCache(): void {
  downsampledCache.clear();
  downsampledCacheBytes = 0;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  pending: Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const pool: WorkerSlot[] = [];
const queue: Array<{
  bytes: Uint8Array;
  targetEdge: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}> = [];
let nextRequestId = 1;
let workersDisabled = false;

export function supportsWorkerTextureDownsample(): boolean {
  return (
    !workersDisabled &&
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof createImageBitmap === "function"
  );
}

function poolLimit(): number {
  const cores = typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : 2;
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(cores / 2) || 2));
}

function scheduleIdleTerminate(slot: WorkerSlot): void {
  if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (slot.busy || slot.pending.size > 0) return;
    const idx = pool.indexOf(slot);
    if (idx >= 0) pool.splice(idx, 1);
    slot.worker.terminate();
  }, IDLE_TERMINATE_MS);
}

function spawnSlot(): WorkerSlot | null {
  try {
    const worker = new Worker(new URL("./texture-downsample-worker.ts", import.meta.url), {
      type: "module",
    });
    const slot: WorkerSlot = { worker, busy: false, pending: new Map(), idleTimer: null };
    worker.onmessage = (event: MessageEvent<TextureDownsampleResponse>) => {
      const msg = event.data;
      const waiter = slot.pending.get(msg.id);
      slot.pending.delete(msg.id);
      slot.busy = false;
      if (waiter) {
        if (msg.ok) waiter.resolve(msg.bytes);
        else waiter.reject(new Error(msg.error));
      }
      pumpQueue();
      if (!slot.busy) scheduleIdleTerminate(slot);
    };
    worker.onerror = (event) => {
      const err = new Error(event.message || "Texture downsample worker failed");
      for (const waiter of slot.pending.values()) waiter.reject(err);
      slot.pending.clear();
      if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
      const idx = pool.indexOf(slot);
      if (idx >= 0) pool.splice(idx, 1);
      worker.terminate();
      workersDisabled = true;
      // Drain remaining queued work via fallback.
      while (queue.length > 0) {
        const next = queue.shift()!;
        void downsampleMainThread(next.bytes, next.targetEdge).then(next.resolve, next.reject);
      }
    };
    pool.push(slot);
    return slot;
  } catch {
    workersDisabled = true;
    return null;
  }
}

function dispatchToSlot(
  slot: WorkerSlot,
  task: { bytes: Uint8Array; targetEdge: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void },
): void {
  if (slot.idleTimer !== null) {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }
  slot.busy = true;
  const id = nextRequestId++;
  slot.pending.set(id, { resolve: task.resolve, reject: task.reject });
  // Copy into a dedicated buffer so transferring it never detaches a caller-owned slice.
  const copy = task.bytes.slice();
  const req: TextureDownsampleRequest = { id, bytes: copy, targetEdge: task.targetEdge };
  slot.worker.postMessage(req, [copy.buffer]);
}

function pumpQueue(): void {
  while (queue.length > 0) {
    let slot = pool.find((candidate) => !candidate.busy);
    if (!slot && pool.length < poolLimit()) {
      slot = spawnSlot() ?? undefined;
    }
    if (!slot) return;
    const task = queue.shift()!;
    dispatchToSlot(slot, task);
  }
}

async function downsampleMainThread(bytes: Uint8Array, targetEdge: number): Promise<Uint8Array> {
  const decoded = await decodeSourceToRgba(bytes, targetEdge);
  return packRawRgbaTexture(decoded.width, decoded.height, decoded.rgba);
}

/**
 * Downsample an image into an `HRGB` raw-RGBA texture payload (uploaded straight to
 * Babylon `RawTexture`, skipping pure-JS PNG encode and browser PNG decode).
 * Uses a pooled Web Worker when supported and caches results by `(cacheKey, targetEdge)`.
 */
export async function downsampleTextureToRawRgba(
  bytes: Uint8Array,
  targetEdge: number,
  cacheKey?: string,
): Promise<Uint8Array> {
  const fullKey = cacheKey ? `${cacheKey}\0${targetEdge}` : undefined;
  if (fullKey) {
    const hit = cacheGet(fullKey);
    if (hit) return hit;
  }
  const result = supportsWorkerTextureDownsample()
    ? await new Promise<Uint8Array>((resolve, reject) => {
        queue.push({ bytes, targetEdge, resolve, reject });
        pumpQueue();
      }).catch(() => downsampleMainThread(bytes, targetEdge))
    : await downsampleMainThread(bytes, targetEdge);
  if (fullKey) cacheSet(fullKey, result);
  return result;
}

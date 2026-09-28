import type { TextureEncodeSettings } from "./texture-compression";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  stubEncodeKtx2,
} from "./texture-compression";

/**
 * A background job's permission to write its Texture (the alignment pass).
 * A guarded job writes nothing before its commit: the Texture keeps its saved
 * state and committed encode until then.
 */
export interface EncodeJobGuard {
  /** Asked when the job reaches the front of the queue; false drops it unencoded. */
  start(assetGuid: string): Promise<boolean>;
  /** Asked right before each write the job causes; false skips that write. */
  canWrite(assetGuid: string): boolean;
}

export interface EncodeJob {
  assetGuid: string;
  source: Uint8Array;
  settings: TextureEncodeSettings;
  mime?: string;
  /** Chunk id to commit under (`textureEncodeChunkId`); else the settings hash. */
  chunkId?: string;
  /** Usage the job encodes for, which an unsaved Details edit may override. */
  usage?: string;
  guard?: EncodeJobGuard;
}

export interface EncodeJobResult {
  assetGuid: string;
  ktx2: Uint8Array;
  wallMs: number;
  settings: TextureEncodeSettings;
  chunkId?: string;
  usage?: string;
  guard?: EncodeJobGuard;
}

export type EncodeFn = (
  source: Uint8Array,
  settings: TextureEncodeSettings,
  mime?: string,
) => Promise<{ ktx2: Uint8Array; wallMs: number }>;

export const DEFAULT_ENCODE_JOB_TIMEOUT_MS = 120_000;

export interface EncodeQueueOptions {
  encode?: EncodeFn;
  /** Recycle the worker/encoder after this many completed jobs (iOS wasm heap). */
  recycleAfter?: number;
  /** Fail the in-flight job so a hung worker cannot deadlock the queue. */
  jobTimeoutMs?: number;
  onState?: (
    assetGuid: string,
    state: "encoding" | "compressed" | "encode_failed",
    job: EncodeJob,
  ) => void;
  onComplete?: (result: EncodeJobResult) => void | Promise<void>;
  onError?: (assetGuid: string, error: unknown, job: EncodeJob) => void;
}

type DerivedJob = { run: () => Promise<void> };

/**
 * Main-thread encode scheduler: one job at a time, pauseable for Preview /
 * background, recycles after N jobs (engineplan §3.5).
 */
export class EncodeQueue {
  private readonly queue: Array<EncodeJob | DerivedJob> = [];
  private readonly encode: EncodeFn;
  private readonly recycleAfter: number;
  private readonly jobTimeoutMs: number;
  private readonly onState?: EncodeQueueOptions["onState"];
  private readonly onComplete?: EncodeQueueOptions["onComplete"];
  private readonly onError?: EncodeQueueOptions["onError"];
  private paused = false;
  private running = false;
  /** The job being encoded, until its result or error is reported. */
  private encoding: EncodeJob | null = null;
  private completedSinceRecycle = 0;
  private recycled = 0;

  constructor(options: EncodeQueueOptions = {}) {
    this.encode = options.encode ?? stubEncodeKtx2;
    this.recycleAfter = options.recycleAfter ?? 5;
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_ENCODE_JOB_TIMEOUT_MS;
    this.onState = options.onState;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
  }

  get depth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  get recycleCount(): number {
    return this.recycled;
  }

  /**
   * A job for this asset waits or is encoding. Its completion callbacks run
   * after this turns false, so they may queue the asset again.
   */
  has(assetGuid: string): boolean {
    if (this.encoding?.assetGuid === assetGuid) return true;
    return this.queue.some((job) => "assetGuid" in job && job.assetGuid === assetGuid);
  }

  enqueue(job: EncodeJob): void {
    this.queue.push({
      ...job,
      settings: { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, ...job.settings },
    });
    void this.pump();
  }

  /** Derived textures share the same one-job admission and Preview pause policy. */
  enqueueDerived<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      const cancel = () => {
        controller.abort(signal?.reason ?? new Error("Asset processing cancelled."));
        if (!started) {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener("abort", cancel);
          reject(controller.signal.reason);
        }
      };
      const job: DerivedJob = { run: async () => {
        started = true;
        const timer = this.jobTimeoutMs > 0 ? setTimeout(() => controller.abort(new Error("Derived texture processing timed out.")), this.jobTimeoutMs) : undefined;
        try {
          controller.signal.throwIfAborted();
          const value = await run(controller.signal);
          controller.signal.throwIfAborted();
          resolve(value);
        } catch (error) { reject(error); }
        finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
      } };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener("abort", cancel, { once: true });
      this.queue.push(job);
      void this.pump();
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.pump();
  }

  private encodeWithTimeout(job: EncodeJob): Promise<{
    ktx2: Uint8Array;
    wallMs: number;
  }> {
    const encodePromise = this.encode(job.source, job.settings, job.mime);
    const timeoutMs = this.jobTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return encodePromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`texture encode timed out for ${job.assetGuid}`),
        );
      }, timeoutMs);
      encodePromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async pump(): Promise<void> {
    if (this.paused || this.running) return;
    const job = this.queue.shift();
    if (!job) return;

    this.running = true;
    if ("run" in job) {
      try { await job.run(); }
      finally { this.running = false; void this.pump(); }
      return;
    }
    this.encoding = job;
    let started = true;
    if (job.guard) {
      // Dropped before any work or write when its guard now refuses it.
      try {
        started = await job.guard.start(job.assetGuid);
      } catch {
        started = false;
      }
    }
    if (!started) {
      this.encoding = null;
      this.running = false;
      void this.pump();
      return;
    }
    this.onState?.(job.assetGuid, "encoding", job);
    try {
      const { ktx2, wallMs } = await this.encodeWithTimeout(job);
      this.encoding = null;
      this.onState?.(job.assetGuid, "compressed", job);
      await this.onComplete?.({
        assetGuid: job.assetGuid,
        ktx2,
        wallMs,
        settings: job.settings,
        ...(job.chunkId ? { chunkId: job.chunkId } : {}),
        ...(job.usage ? { usage: job.usage } : {}),
        ...(job.guard ? { guard: job.guard } : {}),
      });
      this.completedSinceRecycle += 1;
      if (this.completedSinceRecycle >= this.recycleAfter) {
        this.completedSinceRecycle = 0;
        this.recycled += 1;
      }
    } catch (error) {
      this.encoding = null;
      this.onState?.(job.assetGuid, "encode_failed", job);
      this.onError?.(job.assetGuid, error, job);
    } finally {
      this.encoding = null;
      this.running = false;
      void this.pump();
    }
  }
}

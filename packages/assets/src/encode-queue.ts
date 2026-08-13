import type { TextureEncodeSettings } from "./texture-compression";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  stubEncodeKtx2,
} from "./texture-compression";

export interface EncodeJob {
  assetGuid: string;
  source: Uint8Array;
  settings: TextureEncodeSettings;
  mime?: string;
}

export interface EncodeJobResult {
  assetGuid: string;
  ktx2: Uint8Array;
  wallMs: number;
  settings: TextureEncodeSettings;
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
  ) => void;
  onComplete?: (result: EncodeJobResult) => void | Promise<void>;
  onError?: (assetGuid: string, error: unknown) => void;
}

/**
 * Main-thread encode scheduler: one job at a time, pauseable for Preview /
 * background, recycles after N jobs (engineplan §3.5).
 */
export class EncodeQueue {
  private readonly queue: EncodeJob[] = [];
  private readonly encode: EncodeFn;
  private readonly recycleAfter: number;
  private readonly jobTimeoutMs: number;
  private readonly onState?: EncodeQueueOptions["onState"];
  private readonly onComplete?: EncodeQueueOptions["onComplete"];
  private readonly onError?: EncodeQueueOptions["onError"];
  private paused = false;
  private running = false;
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

  enqueue(job: EncodeJob): void {
    this.queue.push({
      ...job,
      settings: { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, ...job.settings },
    });
    void this.pump();
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
    this.onState?.(job.assetGuid, "encoding");
    try {
      const { ktx2, wallMs } = await this.encodeWithTimeout(job);
      this.onState?.(job.assetGuid, "compressed");
      await this.onComplete?.({
        assetGuid: job.assetGuid,
        ktx2,
        wallMs,
        settings: job.settings,
      });
      this.completedSinceRecycle += 1;
      if (this.completedSinceRecycle >= this.recycleAfter) {
        this.completedSinceRecycle = 0;
        this.recycled += 1;
      }
    } catch (error) {
      this.onState?.(job.assetGuid, "encode_failed");
      this.onError?.(job.assetGuid, error);
    } finally {
      this.running = false;
      void this.pump();
    }
  }
}

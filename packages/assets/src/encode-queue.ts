import type { BabassetHeader } from "./babasset";
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
  /**
   * Asked when the job reaches the front of the queue (false drops it
   * unencoded), and right before each write it causes (false skips that
   * write) with `current`, the header of the file that write would replace,
   * read from disk: an external change (a git revert or pull) may have
   * replaced the file the index still describes.
   */
  canWrite(assetGuid: string, current?: BabassetHeader): boolean;
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
  /** sha256 of `source`: the job writes only while the file's `pixels` chunk still has it. */
  sourceSha256?: string;
  /**
   * Set by the queue, which asks nothing of the caller: true once a newer
   * request for the same asset replaced this job (`EncodeQueue.enqueue`). Its
   * result is then never committed and it writes no state.
   */
  superseded?: () => boolean;
}

export interface EncodeJobResult {
  assetGuid: string;
  ktx2: Uint8Array;
  wallMs: number;
  settings: TextureEncodeSettings;
  chunkId?: string;
  usage?: string;
  guard?: EncodeJobGuard;
  sourceSha256?: string;
  superseded?: () => boolean;
}

/**
 * What `EncodeQueue.enqueue` did with a job:
 * - `queued`: the asset had no other job.
 * - `replaced`: the asset had a different request waiting or running, which
 *   this job superseded.
 * - `duplicate`: the asset already has this very request; nothing was queued.
 * - `yielded`: a background (guarded) job gave way to the job the asset
 *   already has; nothing was queued.
 */
export type EncodeEnqueueOutcome = "queued" | "replaced" | "duplicate" | "yielded";

/**
 * Whether a job may make a write to its Texture's file as it is on disk now
 * (`current`): no newer request replaced it, its guard, if any, allows it, and
 * the file's source pixels are still the ones it encoded (`sourceSha256`), so
 * an encode of replaced pixels never lands, whether it is a background or the
 * user's own encode.
 */
export function encodeJobMayWrite(
  job: Pick<EncodeJob, "assetGuid" | "guard" | "sourceSha256" | "superseded">,
  current: BabassetHeader,
): boolean {
  if (job.superseded?.()) return false;
  if (job.guard && !job.guard.canWrite(job.assetGuid, current)) return false;
  if (job.sourceSha256 === undefined) return true;
  return current.chunks.find((chunk) => chunk.kind === "pixels")?.sha256 === job.sourceSha256;
}

/**
 * Encode one source. `signal` aborts when the queue gives up on the job (its
 * timeout): an encoder that can stop should, so a hung encode does not hold
 * the next job behind it.
 */
export type EncodeFn = (
  source: Uint8Array,
  settings: TextureEncodeSettings,
  mime?: string,
  signal?: AbortSignal,
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
  onComplete?: (result: EncodeJobResult, job: EncodeJob) => void | Promise<void>;
  onError?: (assetGuid: string, error: unknown, job: EncodeJob) => void;
  /**
   * A job that writes nothing: a guarded job its guard refused at the front of
   * the queue, a job a newer request replaced while it encoded, or the job
   * that was encoding when `clear()` dropped the queue.
   */
  onDrop?: (job: EncodeJob) => void;
}

type DerivedJob = { run: () => Promise<void>; cancel: (reason: unknown) => void };

/** Whether `next` asks for the very encode `existing` already has, as a user's request. */
function sameEncodeRequest(existing: EncodeJob, next: EncodeJob): boolean {
  if (existing.guard || next.guard) return false;
  const a = existing.settings;
  const b = next.settings;
  return (
    existing.chunkId === next.chunkId &&
    existing.usage === next.usage &&
    existing.mime === next.mime &&
    (existing.sourceSha256 !== undefined
      ? existing.sourceSha256 === next.sourceSha256
      : existing.source === next.source) &&
    a.format === b.format &&
    a.quality === b.quality &&
    a.maxDimension === b.maxDimension &&
    a.generateMipmaps === b.generateMipmaps &&
    a.blockAlign === b.blockAlign
  );
}

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
  private readonly onDrop?: EncodeQueueOptions["onDrop"];
  private paused = false;
  private running = false;
  /** The job being encoded, until its result or error is reported or `clear()` drops it. */
  private encoding: EncodeJob | null = null;
  /** The job whose result or error is being reported, until its callbacks return. */
  private settling: EncodeJob | null = null;
  /** Jobs a newer request for their asset replaced; a waiting one is removed at once. */
  private readonly supersededJobs = new WeakSet<EncodeJob>();
  private completedSinceRecycle = 0;
  private recycled = 0;
  /** Advanced by `clear()`: an encode started before it reports `onDrop`. */
  private generation = 0;

  constructor(options: EncodeQueueOptions = {}) {
    this.encode = options.encode ?? stubEncodeKtx2;
    this.recycleAfter = options.recycleAfter ?? 5;
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_ENCODE_JOB_TIMEOUT_MS;
    this.onState = options.onState;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    this.onDrop = options.onDrop;
  }

  get depth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  get recycleCount(): number {
    return this.recycled;
  }

  /**
   * A job for this asset waits or is encoding. Its completion callbacks run
   * after this turns false, so they may queue the asset again. An encode
   * `clear()` dropped no longer counts, so a reopened project may queue its
   * asset again.
   */
  has(assetGuid: string): boolean {
    if (this.encoding?.assetGuid === assetGuid) return true;
    return this.queue.some((job) => "assetGuid" in job && job.assetGuid === assetGuid);
  }

  /**
   * One job per asset at most: a request the asset already has (`duplicate`)
   * is not queued twice, a changed user's request supersedes the asset's older
   * job (`replaced`: a waiting one is removed, a running one finishes but its
   * result is dropped and it writes no state), and a background (guarded) job
   * gives way to any job the asset has (`yielded`). A job whose result is being
   * reported answers a user's request, but not a background one: its completion
   * callback may queue the asset again.
   */
  enqueue(job: EncodeJob): EncodeEnqueueOutcome {
    const next: EncodeJob = {
      ...job,
      settings: { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, ...job.settings },
    };
    next.superseded = () => this.supersededJobs.has(next);
    const existing = this.liveJobFor(next.assetGuid, !next.guard);
    let outcome: EncodeEnqueueOutcome = "queued";
    if (existing) {
      if (next.guard) return "yielded";
      if (sameEncodeRequest(existing, next)) return "duplicate";
      this.supersede(existing);
      outcome = "replaced";
    }
    this.queue.push(next);
    void this.pump();
    return outcome;
  }

  /** The job an asset's request would meet: waiting, encoding, or (if asked) reporting. */
  private liveJobFor(assetGuid: string, includeSettling: boolean): EncodeJob | undefined {
    const live = (job: EncodeJob | null) =>
      job !== null && job.assetGuid === assetGuid && !this.supersededJobs.has(job) ? job : undefined;
    for (const waiting of this.queue) {
      if ("assetGuid" in waiting && waiting.assetGuid === assetGuid) return waiting;
    }
    return live(this.encoding) ?? (includeSettling ? live(this.settling) : undefined);
  }

  private supersede(job: EncodeJob): void {
    this.supersededJobs.add(job);
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
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
      const job: DerivedJob = { cancel: (reason) => {
        controller.abort(reason);
        signal?.removeEventListener("abort", cancel);
        reject(reason);
      }, run: async () => {
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

  /**
   * Drops the jobs of a closed project: every waiting job (a waiting derived
   * job rejects) and the result of the encode running now, which reports
   * `onDrop` instead of `onComplete` or `onError`. A new project's jobs run
   * after that encode settles.
   */
  clear(): void {
    this.generation += 1;
    this.encoding = null;
    this.settling = null;
    for (const job of this.queue.splice(0)) {
      if ("run" in job) job.cancel(new Error("Asset processing cancelled."));
    }
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
    const timeoutMs = this.jobTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return this.encode(job.source, job.settings, job.mime);
    const controller = new AbortController();
    const encodePromise = this.encode(job.source, job.settings, job.mime, controller.signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error(`texture encode timed out for ${job.assetGuid}`);
        // Stop the hung encoder too, so the next job does not queue behind it.
        controller.abort(error);
        reject(error);
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
    let job = this.queue.shift();
    // A guarded job its guard now refuses is dropped before any work or write.
    while (job && "assetGuid" in job && job.guard && !job.guard.canWrite(job.assetGuid)) {
      this.onDrop?.(job);
      job = this.queue.shift();
    }
    if (!job) return;

    this.running = true;
    if ("run" in job) {
      try { await job.run(); }
      finally { this.running = false; void this.pump(); }
      return;
    }
    const generation = this.generation;
    this.encoding = job;
    this.onState?.(job.assetGuid, "encoding", job);
    try {
      const { ktx2, wallMs } = await this.encodeWithTimeout(job);
      this.encoding = null;
      // A job a newer request replaced reports nothing: the request owns the Texture now.
      if (generation !== this.generation || this.supersededJobs.has(job)) {
        this.onDrop?.(job);
        return;
      }
      this.settling = job;
      this.onState?.(job.assetGuid, "compressed", job);
      await this.onComplete?.({
        assetGuid: job.assetGuid,
        ktx2,
        wallMs,
        settings: job.settings,
        ...(job.chunkId ? { chunkId: job.chunkId } : {}),
        ...(job.usage ? { usage: job.usage } : {}),
        ...(job.guard ? { guard: job.guard } : {}),
        ...(job.sourceSha256 ? { sourceSha256: job.sourceSha256 } : {}),
        ...(job.superseded ? { superseded: job.superseded } : {}),
      }, job);
      this.completedSinceRecycle += 1;
      if (this.completedSinceRecycle >= this.recycleAfter) {
        this.completedSinceRecycle = 0;
        this.recycled += 1;
      }
    } catch (error) {
      this.encoding = null;
      if (generation !== this.generation || this.supersededJobs.has(job)) {
        this.onDrop?.(job);
        return;
      }
      this.settling = job;
      this.onState?.(job.assetGuid, "encode_failed", job);
      this.onError?.(job.assetGuid, error, job);
    } finally {
      this.encoding = null;
      this.settling = null;
      this.running = false;
      void this.pump();
    }
  }
}

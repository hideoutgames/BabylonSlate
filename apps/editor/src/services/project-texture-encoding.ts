import {
  canUseWorkerEncode,
  createWorkerEncodeFn,
  encodeJobMayWrite,
  EncodeQueue,
  isAssetSourceRevisionChanged,
  stubEncodeKtx2,
  type AreaEmissionProcessor,
  type AreaEmissionProgress,
  type AssetRegistry,
  type EncodeFn,
  type EncodeJob,
  type HassetHeader,
  type ImageSize,
  type PluginDescriptor,
} from "@haptic/assets";
import { processAreaEmissionInWorker } from "@haptic/assets/area-emission-client";
import { convertHdrEnvironmentOffMainThread } from "@haptic/assets/import-worker-client";
import { onEncodeQueuePause } from "./encode-queue-pause";
import { guardProjectEncodeQueue } from "./project-authoring-ports";
import type { ProjectWriteAdmission } from "./project-write-admission";
import { committedKtx2Sha256 } from "./project-document-meta";
import { isPluginDocumentReadOnly } from "../lib/plugin-ui";
import { editorEncodeWorkerUrl } from "../lib/public-engine-assets";

export type WorkerEncode = EncodeFn & { dispose: () => void; recycleCount: () => number };

export interface TextureEncodingOptions {
  encode?: EncodeFn;
  processAreaEmission?: AreaEmissionProcessor;
  createWorkerEncode?: () => WorkerEncode | null;
}

/** What the texture pipeline reads from the project session that owns it. */
export interface TextureEncodingHost {
  readonly writeAdmission: ProjectWriteAdmission;
  /** The mounted registry, whatever its session. */
  registry(): AssetRegistry | null;
  /** The registry an encode callback may write through (`ProjectService.encodeRegistry`). */
  encodeRegistry(): AssetRegistry | null;
  sourceSession(): number;
  /** Registry mounts still scanning. */
  registryMounts(): ReadonlySet<{ session: number; promise: Promise<AssetRegistry> }>;
  plugins(): readonly PluginDescriptor[];
  emitRegistryChange(): void;
  pushDiagnostic(line: string): void;
}

/**
 * The project's Texture encode queue and alignment policy: which encodes run,
 * what the editor shows as `encoding`, and which writes Close Project waits for.
 */
export class ProjectTextureEncoding {
  /** The write admission each running encode retains, from its start until its commit or failure ends. */
  private readonly encodeWriteReleases = new Map<EncodeJob, () => void>();
  /** The running encode of each Texture the editor shows as `encoding`: memory only, never saved. */
  private readonly encodingJobs = new Map<string, EncodeJob>();
  private encodingSnapshot: ReadonlySet<string> = new Set();
  private externalEncodePause = false;
  private manualEncodePause = false;
  readonly queue: EncodeQueue;
  readonly publicQueue: EncodeQueue;
  /** The encode result being committed, which Close Project lets finish in its own folder. */
  private textureCommit: Promise<unknown> | null = null;
  /**
   * Texture state writes in flight (a failed encode's `encode_failed`, a retry's
   * `pending`), which Close Project lets finish in their own folder like `textureCommit`.
   */
  private readonly textureStateWrites = new Set<Promise<unknown>>();
  private readonly emissionJobs = new Set<AbortController>();
  private readonly processAreaEmission: AreaEmissionProcessor;
  private workerEncode: WorkerEncode | null = null;
  private encodeQueuePauseUnsubscribe: (() => void) | null = null;
  private readonly configuredEncode?: EncodeFn;
  private readonly createWorkerEncode: () => WorkerEncode | null;
  private transcoderAvailable = true;
  /**
   * The open project's source control **Enable** setting, saved or not. While
   * it is on, nothing re-encodes a Texture in the background: only the user's
   * own edits, and Textures whose committed encode this session wrote, re-align.
   */
  private sourceControlEnabled = false;
  /** The Usage an open Texture tab shows, saved or not (the editor sets it). */
  private openTextureUsage: ((guid: string) => string | undefined) | null = null;
  /**
   * Texture guid -> sha256 of the KTX2 chunk this project session last wrote
   * for it: an encode it committed, or the one a file it created carries (a
   * `.hasset` import, Duplicate or Copy). It exempts the Texture only while
   * that encode is still the committed one in the file on disk: a git revert
   * or pull that replaces it ends the exemption, even for a job queued before.
   */
  private readonly sessionEncodes = new Map<string, string>();
  /** Committed KTX2 (and sniffed source) sizes by chunk sha256, kept across registry remounts of one project. */
  private readonly ktx2SizeCache = new Map<string, ImageSize | null>();
  /** Textures an alignment check is requeuing, shared by remounts as the encode queue is. */
  readonly alignmentRequeues = new Set<string>();
  private textureAlignmentChain: Promise<unknown> = Promise.resolve();
  private readonly textureAlignment = { runs: 0, pending: 0, requeued: new Set<string>() };

  private readonly host: TextureEncodingHost;

  constructor(host: TextureEncodingHost, options: TextureEncodingOptions = {}) {
    this.host = host;
    const { writeAdmission } = host;
    this.configuredEncode = options.encode;
    this.processAreaEmission = options.processAreaEmission ?? processAreaEmissionInWorker;
    this.createWorkerEncode = options.createWorkerEncode ?? (() =>
      canUseWorkerEncode()
        ? createWorkerEncodeFn({ workerUrl: editorEncodeWorkerUrl() })
        : null);
    this.queue = new EncodeQueue({
      // The signal aborts a timed-out job, so the worker encoder can end a hung encode.
      encode: (source, settings, mime, signal) =>
        (this.configuredEncode ?? this.workerEncode ?? stubEncodeKtx2)(
          source,
          settings,
          mime,
          signal,
        ),
      // A running encode writes nothing: the file stays `pending` until the
      // job commits `compressed` (onComplete) or `encode_failed` with its
      // message (onError), and the editor shows `encoding` from memory
      // (`textureEncodingGuids`). A guarded (alignment) job also shows nothing:
      // the Texture keeps its saved state until the job commits, so nothing on
      // disk requeues it later, source control on or not.
      onState: (_guid, state, job) => {
        if (state !== "encoding") return;
        this.encodeWriteReleases.set(job, writeAdmission.retain());
        if (job.guard || !host.encodeRegistry()) return;
        if (this.setTextureEncoding(job, true)) host.emitRegistryChange();
      },
      onComplete: async (result, job) => {
        let succeeded = false;
        try {
          const registry = host.encodeRegistry();
          if (!registry) { succeeded = true; return; }
          const session = host.sourceSession();
          const commit = registry.commitCompressedTexture(result);
          this.textureCommit = commit;
          const committedHere = await commit.finally(() => {
            if (this.textureCommit === commit) this.textureCommit = null;
          });
          if (!committedHere) {
            // A refused commit (a guarded job, or one a newer request replaced)
            // leaves the committed file unchanged.
            if (session === host.sourceSession()) host.emitRegistryChange();
            succeeded = true;
            return;
          }
          if (session !== host.sourceSession()) { succeeded = true; return; }
          const committed = committedKtx2Sha256(registry.getByGuid(result.assetGuid)?.header);
          if (committed) this.sessionEncodes.set(result.assetGuid, committed);
          const current = await this.refreshTextureWrite(result.assetGuid, registry, session);
          if (!current) { succeeded = true; return; }
          // Recheck atlas changes made while this texture encoded, unless an
          // unsaved Details edit selected a different Usage for this result.
          const saved = current.getByGuid(result.assetGuid)?.header.payload.usage;
          const usage = this.openTextureUsage?.(result.assetGuid) ?? String(saved ?? "albedo");
          if (result.usage === undefined || result.usage === usage) {
            this.reconcileInBackground([result.assetGuid]);
          }
          succeeded = true;
        } finally {
          // Otherwise the queue's error callback owns the failed-state commit,
          // and ends the write with it.
          if (succeeded) {
            if (this.setTextureEncoding(job, false)) host.emitRegistryChange();
            this.releaseEncodeWrite(job);
          }
        }
      },
      onError: (guid, error, job) => {
        const release = this.takeEncodeWriteRelease(job);
        this.emitTextureEncodeDiagnostic(guid, error);
        const registry = host.encodeRegistry();
        if (job.guard) {
          // A guarded (alignment) job writes nothing before its commit, so a
          // failed one leaves the committed Texture as it was. Texture Details
          // rechecks whether it is stale now that no job holds it.
          release?.();
          if (registry) host.emitRegistryChange();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!registry) {
          this.setTextureEncoding(job, false);
          release?.();
          return;
        }
        const session = host.sourceSession();
        // The Texture keeps showing as encoding until its failure is saved.
        void this.trackTextureStateWrite(writeAdmission.continue(async () => {
          await registry.setCompressionState(guid, "encode_failed", {
            error: message,
            canWrite: (_guid, current) => encodeJobMayWrite(job, current),
          });
          await this.refreshTextureWrite(guid, registry, session);
        }).catch(failure => this.emitTextureEncodeDiagnostic(guid, failure)).finally(() => {
          if (this.setTextureEncoding(job, false) && session === host.sourceSession()) host.emitRegistryChange();
          release?.();
        }));
      },
      // A guarded job dropped unencoded may leave its Texture stale for the
      // user. A closed project's encode, and one a newer request replaced,
      // end the write they retained here and no longer show as encoding.
      onDrop: (job) => {
        this.setTextureEncoding(job, false);
        this.releaseEncodeWrite(job);
        host.emitRegistryChange();
      },
    });
    this.publicQueue = guardProjectEncodeQueue(this.queue, writeAdmission);
    writeAdmission.subscribe(() => this.updateEncodePause());
  }

  private updateEncodePause(): void {
    if (this.externalEncodePause || this.manualEncodePause || this.host.writeAdmission.locked) this.queue.pause();
    else this.queue.resume();
  }

  /** Start provider-lifetime resources; safe across Strict Mode effect probes. */
  initialize(): void {
    if (this.encodeQueuePauseUnsubscribe) return;
    if (!this.configuredEncode) {
      this.workerEncode = this.createWorkerEncode();
    }
    this.encodeQueuePauseUnsubscribe = onEncodeQueuePause((paused) => {
      this.externalEncodePause = paused;
      this.updateEncodePause();
    });
  }

  /** Release provider-lifetime resources. */
  dispose(): void {
    this.cancelEmissionJobs();
    this.encodeQueuePauseUnsubscribe?.();
    this.encodeQueuePauseUnsubscribe = null;
    this.workerEncode?.dispose();
    this.workerEncode = null;
  }

  /**
   * Close Project, first step: queued encodes belong to this project's
   * registry, and none may commit into the next one. Their Textures stay
   * pending for Retry Encoding.
   */
  dropQueued(): void {
    this.queue.clear();
    // The dropped encode ends its own mark when it settles; none is shown meanwhile.
    this.encodingJobs.clear();
    this.encodingSnapshot = new Set();
    this.sessionEncodes.clear();
    // Sizes are keyed by chunk sha256, so none is wrong in another project,
    // but kept across projects the cache only grows.
    this.ktx2SizeCache.clear();
  }

  /** Close Project, second step: the writes that must land in the closing project's folder. */
  async settle(): Promise<void> {
    this.cancelEmissionJobs();
    // A KTX2 commit already writing must finish before the shared storage is
    // released: the next project would reuse it, and the late write would land
    // in that project's folder. The session bump ends its follow-up work.
    await this.textureCommit?.catch(() => {});
    // So must a state write already running (a failed encode's, a retry's):
    // none starts once the queue is cleared, but a retry may begin meanwhile.
    while (this.textureStateWrites.size > 0) await Promise.allSettled([...this.textureStateWrites]);
  }

  /** A project load starts a session that has written no encodes yet. */
  forgetSessionEncodes(): void {
    this.sessionEncodes.clear();
  }

  /** A file this session creates is its own new work, not one teammates share. */
  noteCreatedTexture(header: HassetHeader): void {
    const committed = committedKtx2Sha256(header);
    if (committed) this.sessionEncodes.set(header.guid, committed);
  }

  /** The write admission `job` retained when its encode started, which the caller now ends. */
  private takeEncodeWriteRelease(job: EncodeJob): (() => void) | undefined {
    const release = this.encodeWriteReleases.get(job);
    this.encodeWriteReleases.delete(job);
    return release;
  }

  private releaseEncodeWrite(job: EncodeJob): void {
    this.takeEncodeWriteRelease(job)?.();
  }

  /**
   * Whether the editor shows the Texture of `job` as `encoding`. Returns
   * whether that changed; the caller tells the editor (`emitRegistryChange`).
   * A job ends its own mark only, so a replaced job's end never clears the
   * newer job's.
   */
  private setTextureEncoding(job: EncodeJob, encoding: boolean): boolean {
    const guid = job.assetGuid;
    const shown = this.encodingJobs.get(guid) === job;
    if (shown === encoding) return false;
    if (encoding) this.encodingJobs.set(guid, job);
    else this.encodingJobs.delete(guid);
    this.encodingSnapshot = new Set(this.encodingJobs.keys());
    return true;
  }

  /** See `ProjectService.textureEncodingGuids`. */
  get encodingGuids(): ReadonlySet<string> {
    return this.encodingSnapshot;
  }

  /** Lets Close Project wait for `write` (see `textureStateWrites`); returns it unchanged. */
  private trackTextureStateWrite<T>(write: Promise<T>): Promise<T> {
    this.textureStateWrites.add(write);
    const forget = () => { this.textureStateWrites.delete(write); };
    void write.then(forget, forget);
    return write;
  }

  private emitTextureEncodeDiagnostic(guid: string, error: unknown, failure = "encode failed"): void {
    const asset = this.host.registry()?.getByGuid(guid);
    const name = asset?.header.name?.trim() || "Texture";
    const message = error instanceof Error ? error.message : String(error);
    this.host.pushDiagnostic(`Texture ${failure} for ${name} (${guid}): ${message}`);
  }

  /** Background alignment pass: a refused or failed pass is reported, never left unhandled. */
  reconcileInBackground(guids: readonly string[]): void {
    this.reconcileTextureAlignment(guids).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.host.pushDiagnostic(`Texture alignment check failed: ${message}`);
    });
  }

  /** A scan may have captured the old encode state before this write committed. */
  private async refreshTextureWrite(guid: string, writer: AssetRegistry, session: number): Promise<AssetRegistry | null> {
    const host = this.host;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (session !== host.sourceSession()) return null;
        // A rejected scan keeps the previous registry; its caller handles the scan error.
        await Promise.allSettled([...host.registryMounts()].filter((mount) => mount.session === session).map((mount) => mount.promise));
        if (session !== host.sourceSession()) return null;
        const current = host.registry();
        if (!current?.getByGuid(guid)) return null;
        try {
          // Refresh only this catalog header; a completed encode never starts a scan or another encode.
          if (current !== writer) await current.getAssetLocator(guid);
        } catch (error) {
          if (isAssetSourceRevisionChanged(error) && attempt < 3) continue;
          throw error;
        }
        if (session !== host.sourceSession()) return null;
        if (current === host.registry() && ![...host.registryMounts()].some((mount) => mount.session === session)) {
          host.emitRegistryChange();
          return current;
        }
      }
      throw new Error("Saved texture metadata changed during 3 refresh attempts; refresh the Content Browser after saving finishes.");
    } catch (error) {
      // A metadata refresh failure must not overwrite a successfully committed encode with encode_failed.
      if (session === host.sourceSession()) this.emitTextureEncodeDiagnostic(guid, error);
      return null;
    }
  }

  /** When self-hosted transcoder files are missing, prefer source chunks. */
  async setTranscoderAvailable(available: boolean): Promise<void> {
    this.transcoderAvailable = available;
    if (!available && this.host.registry()) {
      await this.markCompressedTexturesFallback();
    }
  }

  get isTranscoderAvailable(): boolean {
    return this.transcoderAvailable;
  }

  async markCompressedTexturesFallback(): Promise<void> {
    const registry = this.host.registry();
    if (!registry) return;
    for (const asset of registry.list({ type: "Texture" })) {
      const hasKtx2 = asset.header.chunks.some(
        (chunk) => chunk.kind === "ktx2" || chunk.id.startsWith("ktx2:"),
      );
      const state = asset.header.payload.compressionState;
      if (!hasKtx2 || state !== "compressed") continue;
      // Read-only roots and plugins keep their saved state; without a
      // transcoder the resolver uses their pixels either way.
      if (registry.getRoot(asset.rootId)?.readOnly || isPluginDocumentReadOnly(this.host.plugins(), asset.path)) continue;
      try {
        await registry.setCompressionState(asset.header.guid, "fallback_uncompressed");
      } catch (error) {
        // One unwritable Texture must not stop the others, or the open waiting on them.
        this.emitTextureEncodeDiagnostic(asset.header.guid, error, "fallback state could not be saved");
      }
    }
  }

  /** Pause encode jobs while Preview runs (engineplan §3.5). */
  pause(): void {
    this.manualEncodePause = true;
    this.updateEncodePause();
  }

  resume(): void {
    this.manualEncodePause = false;
    this.updateEncodePause();
  }

  async retryTextureEncoding(
    guid: string,
    options?: { maxDimension?: number; force?: boolean; usage?: string },
  ): Promise<boolean> {
    const registry = this.host.registry();
    if (!registry) return false;
    return this.trackTextureStateWrite(registry.retryTextureEncoding(guid, options));
  }

  /** See `ProjectService.setSourceControlEnabled`. */
  setSourceControlEnabled(enabled: boolean): void {
    if (this.sourceControlEnabled === enabled) return;
    this.sourceControlEnabled = enabled;
  }

  /**
   * Whether the alignment pass may rewrite a Texture now: not read-only, and
   * source control is off or its committed encode is the one this project
   * session last wrote (such as an import a Tileset then picks); a git revert
   * or pull that replaced that encode ends it. Asked again when its job
   * starts, and before its commit with `current`, the file on disk the commit
   * would replace, which the index may not describe yet.
   */
  private alignmentMayWrite(guid: string, current?: HassetHeader): boolean {
    const registry = this.host.registry();
    const asset = registry?.getByGuid(guid);
    if (!registry || !asset) return false;
    if (registry.getRoot(asset.rootId)?.readOnly || isPluginDocumentReadOnly(this.host.plugins(), asset.path)) {
      return false;
    }
    if (!this.sourceControlEnabled) return true;
    const committed = committedKtx2Sha256(current ?? asset.header);
    return committed !== null && this.sessionEncodes.get(guid) === committed;
  }

  /** See `ProjectService.textureAlignmentStale`. */
  async textureAlignmentStale(guid: string, usage?: string): Promise<boolean> {
    const registry = this.host.registry();
    const asset = registry?.getByGuid(guid);
    if (!registry || !asset || isPluginDocumentReadOnly(this.host.plugins(), asset.path)) return false;
    return registry.isTextureAlignmentStale(guid, {
      usage: usage ?? this.openTextureUsage?.(guid),
      ktx2SizeCache: this.ktx2SizeCache,
    });
  }

  /** See `ProjectService.setOpenTextureUsage`. */
  setOpenTextureUsage(usageFor: ((guid: string) => string | undefined) | null): void {
    this.openTextureUsage = usageFor;
  }

  /** See `ProjectService.reconcileTextureAlignment`. */
  reconcileTextureAlignment(guids?: readonly string[]): Promise<number> {
    const { writeAdmission } = this.host;
    if (writeAdmission.blocked) return Promise.resolve(0);
    const run = async () => {
      const registry = this.host.registry();
      if (!registry) return 0;
      const requeued = await registry.reconcileTextureAlignment({
        guids,
        canWrite: (guid, current) => this.alignmentMayWrite(guid, current),
        usageFor: this.openTextureUsage ?? undefined,
        ktx2SizeCache: this.ktx2SizeCache,
      });
      this.textureAlignment.runs += 1;
      for (const guid of requeued) this.textureAlignment.requeued.add(guid);
      if (requeued.length > 0) this.host.emitRegistryChange();
      return requeued.length;
    };
    this.textureAlignment.pending += 1;
    const next = writeAdmission.run(() => this.textureAlignmentChain.then(run, run)).finally(() => {
      this.textureAlignment.pending -= 1;
    });
    this.textureAlignmentChain = next.catch(() => 0);
    return next;
  }

  /** Alignment passes finished and still queued, and every Texture they requeued (test hook). */
  get alignmentState(): { runs: number; pending: number; requeued: string[] } {
    const { runs, pending, requeued } = this.textureAlignment;
    return { runs, pending, requeued: [...requeued] };
  }

  async prepareAreaEmission(guid: string, options: { signal?: AbortSignal; onProgress?: (value: AreaEmissionProgress) => void } = {}): Promise<void> {
    const registry = this.host.registry();
    if (!registry) throw new Error("Open a project before processing emission textures.");
    await this.runEmissionJob(options.signal, async (signal) => {
      await registry.prepareAreaEmission(guid, this.processAreaEmission, { ...options, signal });
      if (this.host.registry() === registry) this.host.emitRegistryChange();
    });
  }

  /** See `ProjectService.reconvertHdrEnvironment`. */
  async reconvertHdrEnvironment(guid: string, faceSize: number, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<boolean> {
    const registry = this.host.registry();
    if (!registry) throw new Error("Open a project before converting environment textures.");
    return this.runEmissionJob(options.signal, async (signal) => {
      const written = await registry.reconvertHdrEnvironment(guid, faceSize, convertHdrEnvironmentOffMainThread, { ...options, signal });
      if (written && this.host.registry() === registry) this.host.emitRegistryChange();
      return written;
    });
  }

  /**
   * Runs `work` with a signal that the caller's `signal` and Close Project
   * (`cancelEmissionJobs`) both abort.
   */
  private async runEmissionJob<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    this.emissionJobs.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      this.emissionJobs.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private cancelEmissionJobs(): void {
    for (const job of this.emissionJobs) job.abort(new Error("Area emission processing cancelled because the project closed."));
    this.emissionJobs.clear();
  }

  async retryAllFailedTextureEncoding(): Promise<number> {
    const host = this.host;
    if (!host.registry()) return 0;
    const session = host.sourceSession();
    let count = 0;
    for (const asset of host.registry()!.list({ type: "Texture" })) {
      // Close Project waits for the retry running, not for the rest of the list.
      const registry = host.registry();
      if (session !== host.sourceSession() || !registry) break;
      const state = asset.header.payload.compressionState;
      if (
        state === "encode_failed" ||
        state === "fallback_uncompressed" ||
        state === "pending" ||
        state === "encoding"
      ) {
        if (await this.trackTextureStateWrite(registry.retryTextureEncoding(asset.header.guid))) {
          count += 1;
        }
      }
    }
    return count;
  }
}

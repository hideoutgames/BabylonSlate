import { useEffect, useRef } from "react";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
} from "@babylonslate/assets";
import {
  captureAssetThumbnailPng,
  captureModelThumbnailPng,
  SCENE_CAPTURE_RETRY_CEILING_MS,
  type ThumbnailCaptureResult,
} from "@babylonslate/render";
import {
  useDocumentActions,
  useEditorShellState,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  subscribeModelThumbnailJobs,
  type ModelThumbnailJob,
} from "../lib/model-thumbnail-queue";
import { prepareAssetThumbnailInput } from "../lib/asset-thumbnail-input";
import { blockingSceneLoadOpen, subscribeBlockingSceneLoads, whenNoBlockingSceneLoad } from "../lib/blocking-scene-loads";
import { collectGpuTextureBytes } from "../lib/collect-gpu-texture-bytes";

/**
 * Interruptions a retry survives. Its next run starts over, so a steady trickle
 * of saves must not make it burn its whole ceiling again and again; the
 * interruption that reaches this count spends the retry.
 */
const MAX_RETRY_INTERRUPTIONS = 3;

/**
 * How a capture ended: its thumbnail was written, it reached its ceiling while
 * still wanted (the one end a longer ceiling can change), or neither.
 */
type CaptureEnd = "written" | "ceiling" | "none";

/**
 * One serialized queue for Content Browser captures on the shared Engine.
 * Model/Animation keep construction GLB materials; saved Materials and Actor
 * Prefabs resolve just their own dependencies through the shared resource cache.
 * Must sit under PlayProvider. Never holds the Importing overlay.
 * The queue pauses while a blocking scene load is open (viewport, document or
 * Play): a capture's shader compiles would count as that load's progress on the
 * shared Engine and keep a stuck load alive. A capture in progress stops and is
 * captured again once the load closes.
 * A capture that reaches its ceiling (not one that fails, stalls on a wait's
 * bound or is superseded) keeps the type icon and is retried once, with a longer
 * ceiling, when nothing else is queued and no blocking load is open. New work
 * interrupts the retry, which keeps its place for a few interruptions, and a
 * newer save of the asset replaces it.
 */
export function ModelThumbnailCaptureHost() {
  const play = useOptionalPlay();
  const { readAssetChunk, createAssetLoadScope, writeAssetThumbnail } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, projectGuid } = useRegistryState();
  const { thumbnailsEnabled } = useEditorShellState();
  const tail = useRef(Promise.resolve());
  const latest = useRef({ assetRegistry, play, readAssetChunk, createAssetLoadScope, writeAssetThumbnail, projectDocument });
  latest.current = { assetRegistry, play, readAssetChunk, createAssetLoadScope, writeAssetThumbnail, projectDocument };
  const retryWaitingRef = useRef<(() => void) | null>(null);
  const sharedEngineGeneration = play?.sharedEngineGeneration;

  useEffect(() => {
    let cancelled = false;
    const lifetime = new AbortController();
    let draining = false;
    let activeKey: string | null = null;
    let activeWork: { guid: string; retry: boolean; cancel: () => void; interrupt: () => void } | null = null;
    const unsubscribeLoads = subscribeBlockingSceneLoads(() => {
      if (blockingSceneLoadOpen()) activeWork?.interrupt();
    });
    const pending = new Map<string, ModelThumbnailJob>();
    // Jobs that found no shared Engine; they run once one is registered.
    const waitingForEngine = new Map<string, ModelThumbnailJob>();
    // Jobs whose capture reached its ceiling; each runs its one retry once `pending` is empty.
    const retryLater = new Map<string, ModelThumbnailJob>();
    // A retry is a private copy of its job (so a caller that reuses its own job
    // object never inherits it), mapped to the times it was interrupted so far.
    const retries = new WeakMap<ModelThumbnailJob, number>();
    const attemptedMissing = new Set<string>();
    const jobKey = (job: ModelThumbnailJob) => job.cacheKey ?? JSON.stringify([job.guid, job.path, job.payload]);
    const unsubscribe = subscribeModelThumbnailJobs((jobs) => {
      if (!thumbnailsEnabled) return;
      for (const job of jobs) {
        if (job.projectGuid && job.projectGuid !== projectGuid) continue;
        const key = jobKey(job);
        if (
          key === activeKey ||
          (job.onlyIfMissing && attemptedMissing.has(key))
        )
          continue;
        // Keep every explicitly selected descriptor; only the active job reads
        // payloads. A later save replaces queued work for the same asset.
        pending.delete(job.guid);
        waitingForEngine.delete(job.guid);
        retryLater.delete(job.guid);
        pending.set(job.guid, job);
        if (activeWork?.guid === job.guid) activeWork.cancel();
      }
      // A retry runs only while nothing else is queued.
      if (pending.size > 0 && activeWork?.retry) activeWork.interrupt();
      drain();
    });
    retryWaitingRef.current = () => {
      if (waitingForEngine.size === 0) return;
      for (const [guid, job] of waitingForEngine) {
        if (!pending.has(guid)) (retries.has(job) ? retryLater : pending).set(guid, job);
      }
      waitingForEngine.clear();
      drain();
    };

    function drain(): void {
      if (draining || (pending.size === 0 && retryLater.size === 0)) return;
      draining = true;
      tail.current = tail.current.then(async () => {
        try {
          while (!cancelled && (pending.size > 0 || retryLater.size > 0)) {
            await whenNoBlockingSceneLoad(lifetime.signal);
            // Retries wait until nothing else is queued.
            const queue = pending.size > 0 ? pending : retryLater;
            if (cancelled || queue.size === 0) break;
            const [guid, job] = queue.entries().next().value!;
            queue.delete(guid);
            activeKey = jobKey(job);
            if (job.onlyIfMissing) {
              attemptedMissing.add(activeKey);
              if (attemptedMissing.size > 256) attemptedMissing.delete(attemptedMissing.values().next().value!);
            }
            try {
              await captureJob(job);
            } catch {
              // A broken source keeps its icon and must not stop later jobs.
            } finally {
              activeKey = null;
            }
            // Give input/painting a turn between captures, including cache hits.
            if (!cancelled && (pending.size || retryLater.size)) await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          draining = false;
        }
      });
    }

    async function captureJob(job: ModelThumbnailJob): Promise<void> {
      if (cancelled) return;
      const scope = latest.current.createAssetLoadScope(`Thumbnail: ${job.guid}`);
      const controller = new AbortController();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        scope.dispose();
      };
      let interrupted = false;
      const retry = retries.has(job);
      const cancel = () => { controller.abort(); release(); };
      const work = { guid: job.guid, retry, cancel, interrupt: () => { interrupted = true; cancel(); } };
      activeWork = work;
      // A load that opened after the queue resumed.
      if (blockingSceneLoadOpen()) work.interrupt();
      const { readAssetChunk } = latest.current;
      let end: CaptureEnd = "none";
      try {
        end = await captureOwnedJob(job, controller.signal, (path, chunkId) => {
          controller.signal.throwIfAborted();
          return readAssetChunk(path, chunkId, { scope, signal: controller.signal, priority: "background" });
        }, retry);
      } finally {
        release();
        if (activeWork === work) activeWork = null;
        if (!cancelled && !pending.has(job.guid)) {
          if (interrupted && end !== "written") {
            // Captured again once the load closes or the new work is done, unless a newer save replaced it.
            if (!retry) pending.set(job.guid, job);
            else {
              const interruptions = retries.get(job)! + 1;
              retries.set(job, interruptions);
              if (interruptions < MAX_RETRY_INTERRUPTIONS) retryLater.set(job.guid, job);
            }
          } else if (!interrupted && end === "ceiling" && !retry) {
            // The type icon stays after a retry that runs out too, without a report.
            const again = { ...job };
            retries.set(again, 0);
            retryLater.set(job.guid, again);
          }
        }
      }
    }

    async function captureOwnedJob(
      job: ModelThumbnailJob,
      signal: AbortSignal,
      readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
      retry: boolean,
    ): Promise<CaptureEnd> {
      const unchanged = () => !cancelled && (!pending.has(job.guid) || jobKey(pending.get(job.guid)!) === jobKey(job));
      const shouldContinue = () => !signal.aborted && unchanged();
      if (!shouldContinue()) return "none";
      const { assetRegistry, play, writeAssetThumbnail, projectDocument } = latest.current;
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) {
        // Keep the job (and a backfill's right to retry) until an Engine exists.
        waitingForEngine.set(job.guid, job);
        attemptedMissing.delete(jobKey(job));
        return "none";
      }
      const ceilingMs = retry ? SCENE_CAPTURE_RETRY_CEILING_MS : undefined;
      const finish = async (capture: ThumbnailCaptureResult): Promise<CaptureEnd> => {
        if (capture.outcome === "expired") return capture.reason === "ceiling" ? "ceiling" : "none";
        // A retry that took long to draw keeps its image when it was only interrupted: it is still the asset's.
        if (capture.outcome !== "captured" || !(retry ? unchanged() : shouldContinue())) return "none";
        if (job.cacheKey && job.projectGuid) {
          await writeAssetThumbnail(job.guid, capture.png, { cacheKey: job.cacheKey, projectGuid: job.projectGuid });
        } else {
          await writeAssetThumbnail(job.guid, capture.png);
        }
        return "written";
      };
      if (job.type === "Material" || job.type === "Class") {
        const asset = assetRegistry?.getByGuid(job.guid);
        if (!asset || !assetRegistry) return "none";
        const input = await prepareAssetThumbnailInput({
          asset,
          registry: assetRegistry,
          readAssetChunk: readChunk,
          collectTextureBytes: (guids) => collectGpuTextureBytes({ assets: assetRegistry.list(), guids, readChunk }),
          shouldContinue,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
        if (!input || !shouldContinue()) return "none";
        return finish(await captureAssetThumbnailPng(engine, input, shouldContinue, undefined, ceilingMs));
      }
      const animation =
        job.type === "Animation"
          ? normalizeAnimationPayload(job.payload)
          : null;
      const model = animation
        ? assetRegistry?.getByGuid(animation.modelGuid)
        : null;
      if (animation && model?.header.type !== "Model") return "none";
      const modelPath = model?.path ?? job.path;
      const modelPayload = normalizeModelPayload(
        model?.header.payload ?? job.payload,
      );
      const bytes = await readChunk(modelPath, "source");
      if (!bytes?.byteLength) return "none";
      let sourceClipBytes: Uint8Array | null = null;
      if (animation?.sourceAnimationGuid) {
        const sourceAnimation = assetRegistry?.getByGuid(
          animation.sourceAnimationGuid,
        );
        if (sourceAnimation?.header.type !== "Animation") return "none";
        const sourceModelGuid = normalizeAnimationPayload(
          sourceAnimation.header.payload,
        ).modelGuid;
        const sourceModel = assetRegistry?.getByGuid(sourceModelGuid);
        if (sourceModel?.header.type !== "Model") return "none";
        sourceClipBytes = await readChunk(sourceModel.path, "source");
        if (!sourceClipBytes?.byteLength) return "none";
      }
      if (!shouldContinue()) return "none";
      return finish(await captureModelThumbnailPng(
        engine,
        bytes,
        [],
        () => null,
        undefined,
        {
          importScale: modelPayload.importScale,
          signal,
          ...(animation
            ? { clipName: animation.clipName, sourceClipBytes }
            : {}),
          ...(ceilingMs === undefined ? {} : { ceilingMs }),
        },
      ));
    }
    return () => {
      cancelled = true;
      lifetime.abort();
      unsubscribeLoads();
      activeWork?.cancel();
      pending.clear();
      waitingForEngine.clear();
      retryLater.clear();
      retryWaitingRef.current = null;
      unsubscribe();
    };
  }, [projectGuid, thumbnailsEnabled]);

  useEffect(() => {
    retryWaitingRef.current?.();
  }, [sharedEngineGeneration]);

  return null;
}

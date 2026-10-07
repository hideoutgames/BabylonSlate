import { useEffect, useRef } from "react";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
} from "@babylonslate/assets";
import { captureAssetThumbnailPng, captureModelThumbnailPng } from "@babylonslate/render";
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
import { collectGpuTextureBytes } from "../lib/collect-gpu-texture-bytes";

/**
 * One serialized queue for Content Browser captures on the shared Engine.
 * Model/Animation keep construction GLB materials; saved Materials and Actor
 * Prefabs resolve just their own dependencies through the shared resource cache.
 * Must sit under PlayProvider. Never holds the Importing overlay.
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

  useEffect(() => {
    let cancelled = false;
    let draining = false;
    let activeKey: string | null = null;
    let activeWork: { guid: string; cancel: () => void } | null = null;
    const pending = new Map<string, ModelThumbnailJob>();
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
        pending.set(job.guid, job);
        if (activeWork?.guid === job.guid) activeWork.cancel();
      }
      if (draining || pending.size === 0) return;
      draining = true;
      tail.current = tail.current.then(async () => {
        try {
          while (!cancelled && pending.size > 0) {
            const [guid, job] = pending.entries().next().value!;
            pending.delete(guid);
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
            if (!cancelled && pending.size) await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          draining = false;
        }
      });
    });

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
      const work = { guid: job.guid, cancel: () => { controller.abort(); release(); } };
      activeWork = work;
      const { readAssetChunk } = latest.current;
      try {
        await captureOwnedJob(job, controller.signal, (path, chunkId) => {
          controller.signal.throwIfAborted();
          return readAssetChunk(path, chunkId, { scope, signal: controller.signal, priority: "background" });
        });
      } finally {
        release();
        if (activeWork === work) activeWork = null;
      }
    }

    async function captureOwnedJob(
      job: ModelThumbnailJob,
      signal: AbortSignal,
      readChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
    ): Promise<void> {
      const shouldContinue = () => !cancelled && !signal.aborted && (!pending.has(job.guid) || jobKey(pending.get(job.guid)!) === jobKey(job));
      if (!shouldContinue()) return;
      const { assetRegistry, play, writeAssetThumbnail, projectDocument } = latest.current;
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) return;
      const write = async (png: Uint8Array | null) => {
        if (!png || !shouldContinue()) return;
        if (job.cacheKey && job.projectGuid) {
          await writeAssetThumbnail(job.guid, png, { cacheKey: job.cacheKey, projectGuid: job.projectGuid });
        } else {
          await writeAssetThumbnail(job.guid, png);
        }
      };
      if (job.type === "Material" || job.type === "Class" || job.type === "Graph") {
        const asset = assetRegistry?.getByGuid(job.guid);
        if (!asset || !assetRegistry) return;
        const input = await prepareAssetThumbnailInput({
          asset,
          registry: assetRegistry,
          readAssetChunk: readChunk,
          collectTextureBytes: (guids) => collectGpuTextureBytes({ assets: assetRegistry.list(), guids, readChunk }),
          shouldContinue,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
        if (input && shouldContinue()) await write(await captureAssetThumbnailPng(engine, input, shouldContinue));
        return;
      }
      const animation =
        job.type === "Animation"
          ? normalizeAnimationPayload(job.payload)
          : null;
      const model = animation
        ? assetRegistry?.getByGuid(animation.modelGuid)
        : null;
      if (animation && model?.header.type !== "Model") return;
      const modelPath = model?.path ?? job.path;
      const modelPayload = normalizeModelPayload(
        model?.header.payload ?? job.payload,
      );
      const bytes = await readChunk(modelPath, "source");
      if (!bytes?.byteLength) return;
      let sourceClipBytes: Uint8Array | null = null;
      if (animation?.sourceAnimationGuid) {
        const sourceAnimation = assetRegistry?.getByGuid(
          animation.sourceAnimationGuid,
        );
        if (sourceAnimation?.header.type !== "Animation") return;
        const sourceModelGuid = normalizeAnimationPayload(
          sourceAnimation.header.payload,
        ).modelGuid;
        const sourceModel = assetRegistry?.getByGuid(sourceModelGuid);
        if (sourceModel?.header.type !== "Model") return;
        sourceClipBytes = await readChunk(sourceModel.path, "source");
        if (!sourceClipBytes?.byteLength) return;
      }
      if (!shouldContinue()) return;
      const png = await captureModelThumbnailPng(
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
        },
      );
      await write(png);
    }
    return () => {
      cancelled = true;
      activeWork?.cancel();
      pending.clear();
      unsubscribe();
    };
  }, [projectGuid, thumbnailsEnabled]);

  return null;
}

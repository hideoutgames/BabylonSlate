import { useEffect, useRef } from "react";
import {
  normalizeAnimationPayload,
  normalizeModelPayload,
} from "@babylonslate/assets";
import { captureModelThumbnailPng } from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  subscribeModelThumbnailJobs,
  type ModelThumbnailJob,
} from "../lib/model-thumbnail-queue";

/**
 * Capture Model/Animation Content Browser thumbs on the shared Engine.
 * Construction GLB only — no slot MaterialLibrary or extra ResourceCache
 * (those upload a second 512MiB texture set and can lose the WebGL context).
 * Must sit under PlayProvider. Never holds the Importing overlay.
 */
export function ModelThumbnailCaptureHost() {
  const play = useOptionalPlay();
  const {
    assetRegistry,
    thumbnailsEnabled,
    readAssetChunk,
    writeAssetThumbnail,
  } = useDocuments();
  const tail = useRef(Promise.resolve());
  const pending = useRef(new Set<string>());
  const attemptedMissing = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    return subscribeModelThumbnailJobs((jobs) => {
      if (!thumbnailsEnabled) return;
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) return;
      for (const job of jobs) {
        const key = JSON.stringify([job.guid, job.path, job.payload]);
        if (
          pending.current.has(key) ||
          (job.onlyIfMissing && attemptedMissing.current.has(key))
        )
          continue;
        pending.current.add(key);
        if (job.onlyIfMissing) attemptedMissing.current.add(key);
        // Serialize throwaway Scenes, including jobs from separate import/save
        // batches, so captures cannot compete for the shared Engine.
        tail.current = tail.current.then(async () => {
          try {
            await captureJob(job);
          } catch {
            // A broken source keeps its icon and must not stop later jobs.
          } finally {
            pending.current.delete(key);
          }
        });
      }
    });

    async function captureJob(job: ModelThumbnailJob): Promise<void> {
      if (!mounted.current) return;
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) return;
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
      const bytes = await readAssetChunk(modelPath, "source");
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
        sourceClipBytes = await readAssetChunk(sourceModel.path, "source");
        if (!sourceClipBytes?.byteLength) return;
      }
      if (!mounted.current) return;
      const png = await captureModelThumbnailPng(
        engine,
        bytes,
        [],
        () => null,
        undefined,
        {
          importScale: modelPayload.importScale,
          ...(animation
            ? { clipName: animation.clipName, sourceClipBytes }
            : {}),
        },
      );
      if (png && mounted.current) await writeAssetThumbnail(job.guid, png);
    }
  }, [
    assetRegistry,
    play,
    readAssetChunk,
    thumbnailsEnabled,
    writeAssetThumbnail,
  ]);

  return null;
}

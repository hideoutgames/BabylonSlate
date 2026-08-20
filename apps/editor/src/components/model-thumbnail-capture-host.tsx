import { useEffect } from "react";
import { captureModelThumbnailPng } from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  subscribeModelThumbnailJobs,
  type ModelThumbnailJob,
} from "../lib/model-thumbnail-queue";

/**
 * Capture Model Content Browser thumbs on the shared Engine after import/save.
 * Construction GLB only — no slot MaterialLibrary or extra ResourceCache
 * (those upload a second 512MiB texture set and can lose the WebGL context).
 * Must sit under PlayProvider. Never holds the Importing overlay.
 */
export function ModelThumbnailCaptureHost() {
  const play = useOptionalPlay();
  const { thumbnailsEnabled, readAssetChunk, writeAssetThumbnail } =
    useDocuments();

  useEffect(() => {
    return subscribeModelThumbnailJobs((jobs) => {
      if (!thumbnailsEnabled) return;
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) return;
      void captureJobs(jobs);
    });

    async function captureJobs(jobs: ModelThumbnailJob[]): Promise<void> {
      const engine = play?.ensureSharedEngine() ?? null;
      if (!engine) return;
      for (const job of jobs) {
        const bytes = await readAssetChunk(job.path, "source");
        if (!bytes || bytes.byteLength === 0) continue;
        const png = await captureModelThumbnailPng(
          engine,
          bytes,
          [],
          () => null,
        );
        if (png) await writeAssetThumbnail(job.guid, png);
      }
    }
  }, [play, readAssetChunk, thumbnailsEnabled, writeAssetThumbnail]);

  return null;
}

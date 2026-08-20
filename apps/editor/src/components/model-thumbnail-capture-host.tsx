import { useEffect } from "react";
import {
  modelMaterialGuids,
  normalizeModelPayload,
} from "@babylonslate/assets";
import {
  MaterialLibrary,
  captureModelThumbnailPng,
  getMaterialTexture,
  materialUnavailable,
  resourceCacheForEngine,
} from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import {
  subscribeModelThumbnailJobs,
  type ModelThumbnailJob,
} from "../lib/model-thumbnail-queue";

/**
 * Capture Model Content Browser thumbs on the shared Engine after import/save.
 * Must sit under PlayProvider. Never holds the Importing overlay.
 */
export function ModelThumbnailCaptureHost() {
  const play = useOptionalPlay();
  const {
    thumbnailsEnabled,
    readAssetChunk,
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    writeAssetThumbnail,
  } = useDocuments();

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
        const payload = normalizeModelPayload(job.payload);
        const extraGuids = modelMaterialGuids(payload);
        const materials = await collectPlayMaterialLibrary(
          undefined,
          [],
          extraGuids,
        );
        const textureBytes = await collectPlayTextureBytes(
          new Map(),
          new Map(),
          materials.textureGuids,
        );
        const cache = resourceCacheForEngine(engine);
        const library = new MaterialLibrary({
          functions: () => Object.fromEntries(materials.functions),
          resolveTexture: (guid) => {
            const data = textureBytes.get(guid);
            if (!data) return null;
            return getMaterialTexture(cache, guid, engine, data);
          },
        });
        try {
          const png = await captureModelThumbnailPng(
            engine,
            bytes,
            payload.materialSlots,
            (guid, scene) => {
              const document = materials.documents.get(guid);
              if (!document) return null;
              const acquired = library.acquire(scene, guid, document);
              return materialUnavailable(acquired) ? null : acquired.material;
            },
          );
          if (png) await writeAssetThumbnail(job.guid, png);
        } finally {
          library.dispose();
        }
      }
    }
  }, [
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    play,
    readAssetChunk,
    thumbnailsEnabled,
    writeAssetThumbnail,
  ]);

  return null;
}

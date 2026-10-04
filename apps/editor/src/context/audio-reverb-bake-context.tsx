import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  bakeAudioReverb,
  type AudioReverbGeometry,
} from "@babylonslate/assets";
import { useDocuments } from "./document-context";
import { playSceneLibraryPaths } from "../lib/plugin-ui";
import {
  collectAudioReverbFlushScenes,
  createAudioReverbBakeController,
  registerAudioReverbSaveFlush,
  sceneFromDocument,
  staticAudioGeometryFingerprint,
  type AudioReverbBakeController,
} from "../lib/audio-reverb-bake";
import { createAudioReverbWorker } from "../services/audio-reverb-worker-host";

function createBakeFn(workerRef: {
  current: ReturnType<typeof createAudioReverbWorker> | null;
}): (
  geometry: AudioReverbGeometry,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  try {
    if (typeof Worker === "undefined") {
      return async (geometry) => bakeAudioReverb(geometry);
    }
    const worker = createAudioReverbWorker();
    workerRef.current = worker;
    return (geometry, signal) => worker.bake(geometry, signal);
  } catch {
    return async (geometry) => bakeAudioReverb(geometry);
  }
}

export function AudioReverbBakeProvider({ children }: { children: ReactNode }) {
  const {
    openDocuments,
    writeSceneAudioReverbChunk,
    loadAssetDocument,
    projectDocument,
    assetRegistry,
  } = useDocuments();
  const controllerRef = useRef<AudioReverbBakeController | null>(null);
  const workerRef = useRef<ReturnType<typeof createAudioReverbWorker> | null>(
    null,
  );
  // The bake controller and Save flush outlive renders and read these when
  // they run. Updated after commit, never during render.
  const latest = {
    write: writeSceneAudioReverbChunk,
    loadAssetDocument,
    projectDocument,
    assetRegistry,
  };
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });

  const fingerprints = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = createAudioReverbBakeController({
      bake: createBakeFn(workerRef),
      write: async (entry) => {
        await latestRef.current.write(entry.path, entry.bytes, entry.payload);
      },
    });
    controllerRef.current = controller;
    registerAudioReverbSaveFlush(async (persistedScenes) => {
      if (persistedScenes) {
        await controller.flushAll(persistedScenes);
        return;
      }
      const { projectDocument, assetRegistry } = latestRef.current;
      const paths = playSceneLibraryPaths(
        projectDocument?.scenes ?? [],
        assetRegistry?.list() ?? [],
      );
      const scenes = await collectAudioReverbFlushScenes({
        paths,
        load: (path) => latestRef.current.loadAssetDocument("scene", path),
      });
      await controller.flushAll(scenes);
    });
    return () => {
      registerAudioReverbSaveFlush(null);
      controller.dispose();
      workerRef.current?.terminate();
      workerRef.current = null;
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    for (const doc of openDocuments) {
      if (doc.ref.kind !== "scene") continue;
      const scene = sceneFromDocument(doc.content);
      if (!scene) continue;
      const fingerprint = staticAudioGeometryFingerprint(scene);
      if (fingerprints.current.get(doc.ref.path) === fingerprint) continue;
      fingerprints.current.set(doc.ref.path, fingerprint);
      controller.schedule(doc.ref.path, scene);
    }
  }, [openDocuments]);

  return children;
}

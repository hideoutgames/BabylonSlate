import { useEffect, useRef, type ReactNode } from "react";
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
  const writeRef = useRef(writeSceneAudioReverbChunk);
  writeRef.current = writeSceneAudioReverbChunk;
  const loadAssetDocumentRef = useRef(loadAssetDocument);
  loadAssetDocumentRef.current = loadAssetDocument;
  const projectDocumentRef = useRef(projectDocument);
  projectDocumentRef.current = projectDocument;
  const assetRegistryRef = useRef(assetRegistry);
  assetRegistryRef.current = assetRegistry;

  const fingerprints = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = createAudioReverbBakeController({
      bake: createBakeFn(workerRef),
      write: async (entry) => {
        await writeRef.current(entry.path, entry.bytes, entry.payload);
      },
    });
    controllerRef.current = controller;
    registerAudioReverbSaveFlush(async () => {
      const paths = playSceneLibraryPaths(
        projectDocumentRef.current?.scenes ?? [],
        assetRegistryRef.current?.list() ?? [],
      );
      const scenes = await collectAudioReverbFlushScenes({
        paths,
        load: (path) => loadAssetDocumentRef.current("scene", path),
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

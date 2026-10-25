import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  bakeAudioReverb,
  type AudioReverbGeometry,
} from "@haptic/assets";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "./document-context";
import { playSceneLibraryPaths } from "../lib/plugin-ui";
import {
  collectAudioReverbFlushScenes,
  createAudioReverbBakeController,
  registerAudioReverbSaveFlush,
  sceneFromDocument,
  staticAudioGeometryFingerprint,
  type AudioReverbBakeController,
} from "../lib/audio-reverb-bake";
import {
  createAudioReverbWorker,
  type AudioReverbWorkerHost,
} from "../services/audio-reverb-worker-host";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

const SCENE_KINDS = ["scene"] as const;

/**
 * Each bake gets its own worker, stopped when the bake settles: a timed-out
 * bake then stops computing instead of delaying the bakes after it.
 */
function createBakeFn(live: Set<AudioReverbWorkerHost>): (
  geometry: AudioReverbGeometry,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  if (typeof Worker === "undefined") {
    return async (geometry) => bakeAudioReverb(geometry);
  }
  return async (geometry, signal) => {
    let host: AudioReverbWorkerHost;
    try {
      host = createAudioReverbWorker();
    } catch {
      return bakeAudioReverb(geometry);
    }
    live.add(host);
    try {
      return await host.bake(geometry, signal);
    } finally {
      live.delete(host);
      host.terminate();
    }
  };
}

export function AudioReverbBakeProvider({ children }: { children: ReactNode }) {
  const { writeSceneAudioReverbChunk, withSceneWrite, loadAssetDocument } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry } = useRegistryState();
  // Only Scene edits can change static audio geometry.
  const sceneDocuments = useOpenDocumentsOfKinds(SCENE_KINDS);
  const controllerRef = useRef<AudioReverbBakeController | null>(null);
  // The bake controller and Save flush outlive renders and read these when
  // they run. Updated after commit, never during render.
  const latest = {
    write: writeSceneAudioReverbChunk,
    withSceneWrite,
    loadAssetDocument,
    projectDocument,
    assetRegistry,
  };
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });

  const fingerprints = useRef(new Map<string, string>());
  // Scene edits replace the document content, so an unchanged Scene keeps its
  // object and its fingerprint while other open Scenes change.
  const fingerprintByContent = useRef(new WeakMap<object, string>());

  useEffect(() => {
    const workers = new Set<AudioReverbWorkerHost>();
    const controller = createAudioReverbBakeController({
      bake: createBakeFn(workers),
      withWrite: work => latestRef.current.withSceneWrite(writer => work(entry =>
        writer.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload))),
      write: async (entry) => {
        await latestRef.current.write(entry.path, entry.bytes, entry.payload);
      },
    });
    controllerRef.current = controller;
    registerAudioReverbSaveFlush(async (persistedScenes, writer) => {
      const write = writer ? (entry: import("../lib/audio-reverb-bake").AudioReverbBakeWrite) =>
        writer.writeSceneAudioReverbChunk(entry.path, entry.bytes, entry.payload) : undefined;
      if (persistedScenes) return controller.flushAll(persistedScenes, write);
      const { projectDocument, assetRegistry } = latestRef.current;
      const paths = playSceneLibraryPaths(
        projectDocument?.scenes ?? [],
        assetRegistry?.list() ?? [],
      );
      const { scenes } = await collectAudioReverbFlushScenes({
        paths,
        load: (path) => latestRef.current.loadAssetDocument("scene", path),
      });
      return controller.flushAll(scenes, write);
    });
    return () => {
      registerAudioReverbSaveFlush(null);
      controller.dispose();
      for (const worker of [...workers]) worker.terminate();
      workers.clear();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    for (const doc of sceneDocuments) {
      const scene = sceneFromDocument(doc.content);
      if (!scene) continue;
      let fingerprint = fingerprintByContent.current.get(scene);
      if (fingerprint === undefined) {
        fingerprint = staticAudioGeometryFingerprint(scene);
        fingerprintByContent.current.set(scene, fingerprint);
      }
      if (fingerprints.current.get(doc.ref.path) === fingerprint) continue;
      fingerprints.current.set(doc.ref.path, fingerprint);
      controller.schedule(doc.ref.path, scene);
    }
  }, [sceneDocuments]);

  return children;
}

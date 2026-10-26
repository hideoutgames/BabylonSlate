import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SceneSourceAssets } from "@haptic/render";
import {
  acquirePlayAssetSources,
  createMergedPlaySourceControls,
  type PlayAssetSourceHost,
} from "../services/play-asset-sources";
import type { PlaySceneLoad } from "../services/play-physics";

/**
 * The asset sources a Play session holds: the startup set, the project
 * systems' set and every set the running game acquires, all released together.
 * `requestPlay` acquires the startup sets through the returned refs, so its
 * session check and the content it commits run in one step.
 */
export function usePlayAssetSources({
  resetContent,
  setSessionPlayScene,
}: {
  /** Empties the Play content when the startup sources are released. */
  resetContent: () => void;
  setSessionPlayScene: Dispatch<SetStateAction<PlaySceneLoad | null>>;
}) {
  const playSourceHostRef = useRef<PlayAssetSourceHost | null>(null);
  const playSourceLifetimeRef = useRef<AbortController | null>(null);
  const playSourceSetsRef = useRef(new Set<Awaited<ReturnType<typeof acquirePlayAssetSources>>>());
  /** Merged Play source controls, rebuilt only when the live source sets change. */
  const mergedSourceControls = useMemo(() => createMergedPlaySourceControls(() => playSourceSetsRef.current), []);
  const initialPlaySourceRef = useRef<Awaited<ReturnType<typeof acquirePlayAssetSources>> | null>(null);
  const [sessionSources, setSessionSources] = useState<SceneSourceAssets>();
  const acquireAssetSources = useCallback(async (
    guids: readonly string[],
    options: { consumer: string; signal: AbortSignal; priority?: import("@haptic/assets").AssetLoadPriority; onProgress?: (progress: number) => void; fontModes?: import("@haptic/render").CommandFontModes },
  ) => {
    const host = playSourceHostRef.current;
    const lifetime = playSourceLifetimeRef.current;
    if (!host || !lifetime) throw new Error("The Play asset session is closed.");
    const prepared = await acquirePlayAssetSources(host, guids, {
      ...options, signal: AbortSignal.any([options.signal, lifetime.signal]),
      onProgress: ({ completed, total }) => options.onProgress?.(total ? completed / total : 1),
    });
    if (playSourceHostRef.current !== host) { prepared.release(); throw new Error("The project changed during asset preparation."); }
    playSourceSetsRef.current.add(prepared);
    return {
      ...prepared,
      getControls: mergedSourceControls,
      release: () => { playSourceSetsRef.current.delete(prepared); prepared.release(); },
      controlsAfterRelease: mergedSourceControls,
    };
  }, [mergedSourceControls]);
  const acquireSceneSources = useCallback(async (guid: string, options: { consumer: string; signal: AbortSignal }) => {
    const prepared = await acquireAssetSources([guid], options);
    const scene = prepared.game.scenes.get(guid);
    if (!scene) { prepared.release(); throw new Error(`Scene ${guid} could not be prepared.`); }
    return { ...prepared, scene, audioReverb: prepared.game.audioReverbBytes.get(guid) ?? null };
  }, [acquireAssetSources]);
  const releaseInitialSources = useCallback(() => {
    const prepared = initialPlaySourceRef.current;
    if (prepared) {
      playSourceSetsRef.current.delete(prepared);
      prepared.release();
      initialPlaySourceRef.current = null;
    }
    setSessionPlayScene(null);
    resetContent();
  }, [resetContent, setSessionPlayScene]);
  /** On-demand Complex Collision: cook from whichever retained source set holds the Model. */
  const cookPlayComplexCollision = useCallback(async (guid: string) => {
    for (const prepared of playSourceSetsRef.current)
      if (prepared.game.modelBytes.has(guid)) return prepared.cookComplexCollision(guid);
    return null;
  }, []);
  /** Ends the source lifetime and releases every set; the session state kept beside them is the caller's. */
  const releaseAllSources = useCallback(() => {
    playSourceLifetimeRef.current?.abort();
    playSourceLifetimeRef.current = null;
    playSourceHostRef.current = null;
    releaseInitialSources();
    for (const sources of playSourceSetsRef.current) sources.release();
    playSourceSetsRef.current.clear();
    mergedSourceControls.reset();
    setSessionSources(undefined);
  }, [releaseInitialSources, mergedSourceControls]);
  return {
    playSourceHostRef,
    playSourceLifetimeRef,
    playSourceSetsRef,
    initialPlaySourceRef,
    mergedSourceControls,
    sessionSources,
    setSessionSources,
    acquireAssetSources,
    acquireSceneSources,
    releaseInitialSources,
    cookPlayComplexCollision,
    releaseAllSources,
  };
}

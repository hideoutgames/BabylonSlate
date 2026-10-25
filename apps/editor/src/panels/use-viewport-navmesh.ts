import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { engineCommandBus, isSceneWorkspaceKind, type SerializedScene } from "@haptic/core";
import { NAVMESH_CHUNK_ID } from "@haptic/navigation";
import {
  collectNavBakeGeometry,
  navDebugBlockersFromActors,
  type EngineHandle,
  type NavMeshDebugOverlay,
} from "@haptic/render";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import type { OpenDocument } from "../services/document-service";

export interface ViewportNavmeshDeps {
  engineRef: RefObject<EngineHandle | null>;
  sceneRef: RefObject<SerializedScene | null>;
  navDebugRef: RefObject<NavMeshDebugOverlay | null>;
  /** Advances when a new Engine creates the overlay. */
  navOverlayGeneration: number;
  doc: OpenDocument | undefined;
  scene: SerializedScene | null;
}

/**
 * Show Navmesh and Nav Bake for the viewport: registers the bake's geometry
 * collector and keeps the navmesh debug overlay in step with the scene and the
 * stored or last baked navmesh. React runs its effects in call order, so the
 * panel calls it where these effects have always run.
 */
export function useViewportNavmesh({
  engineRef,
  sceneRef,
  navDebugRef,
  navOverlayGeneration,
  doc,
  scene,
}: ViewportNavmeshDeps): void {
  const { readAssetChunk } = useDocumentActions();
  const { registryEpoch } = useRegistryState();
  const { navmeshVisible } = useSceneEditing();
  const navBake = useOptionalNavBake();
  const registerNavBakeCollector = navBake?.registerCollector;
  useEffect(() => {
    if (!registerNavBakeCollector) return;
    registerNavBakeCollector((extras) => {
      const handle = engineRef.current;
      const current = sceneRef.current;
      if (!handle?.editor || !current) {
        return { positions: [], indices: [] };
      }
      return collectNavBakeGeometry(handle.editor.sync, current, extras);
    });
    return () => registerNavBakeCollector(null);
  }, [registerNavBakeCollector, engineRef, sceneRef]);

  // A scene edit retries a failed overlay, so one cause is logged once.
  const navmeshFailureRef = useRef<string | null>(null);
  const reportNavmeshFailure = useCallback((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    if (navmeshFailureRef.current === reason) return;
    navmeshFailureRef.current = reason;
    engineCommandBus.dispatch({ type: "log", message: `Show Navmesh could not draw the navmesh: ${reason}` });
  }, []);
  const navmeshPath =
    doc && isSceneWorkspaceKind(doc.ref.kind) ? doc.ref.path : null;
  const navmeshOverlayOn = Boolean(
    scene && (navmeshVisible || scene.settings.showNavmesh === true),
  );
  const lastBakedNavmesh = navBake?.lastBytes ?? null;
  // The stored chunk changes only with the asset (a registry change), so scene
  // edits redraw blockers from the bytes already read.
  const [storedNavmesh, setStoredNavmesh] = useState<{
    path: string;
    bytes: Uint8Array | null;
  } | null>(null);
  useEffect(() => {
    void registryEpoch;
    if (!navmeshOverlayOn || !navmeshPath || lastBakedNavmesh) return;
    let cancelled = false;
    void (async () => {
      let bytes: Uint8Array | null = null;
      try {
        bytes = (await readAssetChunk(navmeshPath, NAVMESH_CHUNK_ID)) ?? null;
      } catch (error) {
        // The blockers still draw without the bake.
        if (!cancelled) reportNavmeshFailure(error);
      }
      if (!cancelled) setStoredNavmesh({ path: navmeshPath, bytes });
    })();
    return () => {
      cancelled = true;
    };
  }, [lastBakedNavmesh, navmeshOverlayOn, navmeshPath, readAssetChunk, registryEpoch, reportNavmeshFailure]);

  useEffect(() => {
    const overlay = navDebugRef.current;
    if (!overlay || !navmeshOverlayOn || !scene) {
      overlay?.clear();
      return;
    }
    const stored = storedNavmesh?.path === navmeshPath ? storedNavmesh : null;
    // Wait for this scene's stored chunk unless a bake supplies the bytes.
    if (navmeshPath && !lastBakedNavmesh && !stored) return;
    overlay.sync(
      lastBakedNavmesh ?? stored?.bytes ?? null,
      navDebugBlockersFromActors(scene.actors),
      scene.settings.physicsWorld,
    ).then(() => { navmeshFailureRef.current = null; }, reportNavmeshFailure);
  }, [
    lastBakedNavmesh,
    navOverlayGeneration,
    navmeshOverlayOn,
    navmeshPath,
    reportNavmeshFailure,
    scene,
    storedNavmesh,
    navDebugRef,
  ]);
}

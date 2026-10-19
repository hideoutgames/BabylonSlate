import { installTextureBytes } from "@babylonslate/render";
import { useEffect, useRef, useState } from "react";
import type { AbstractEngine } from "@babylonjs/core";
import {
  DEFAULT_SKYBOX_SIZE,
  SKYBOX_FACE_KEYS,
  emptySkyboxFaces,
  type SkyboxFaceKey,
} from "@babylonslate/core";
import {
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  createSkyboxMeshForFaces,
  resourceCacheForEngine,
} from "@babylonslate/render";
import { useOptionalPlay } from "../context/play-context";
import { watchBlockingEditorOverlay } from "../lib/viewport-render-gate";

export type SkyboxCreatorPreviewFacePngs = Record<SkyboxFaceKey, Uint8Array>;

function hideDefaultPreviewMesh(host: {
  mesh?: { setEnabled?: (enabled: boolean) => void; isVisible?: boolean };
}): void {
  const mesh = host.mesh;
  if (!mesh) return;
  mesh.setEnabled?.(false);
  if ("isVisible" in mesh) mesh.isVisible = false;
}

/** Live cubemap from in-memory sliced faces on the shared Engine; drag to look around. */
export function SkyboxCreatorPreviewCanvas({
  facePngs,
  testId = "skybox-creator-preview-canvas",
}: {
  facePngs: SkyboxCreatorPreviewFacePngs;
  testId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const faceKey = SKYBOX_FACE_KEYS.map((key) => facePngs[key]?.byteLength ?? 0).join(",");

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: ReturnType<typeof createMaterialPreviewScene> | null = null;
    let presenter: ReturnType<typeof createMaterialPreviewPresenter> | null =
      null;
    let frame = 0;
    let gestures: { dispose: () => void } | null = null;
    const overlay = watchBlockingEditorOverlay();
    try {
      host = createMaterialPreviewScene(engine);
      if (!host || cancelled) {
        overlay.dispose();
        host?.dispose();
        return;
      }
      hideDefaultPreviewMesh(host);
      const cache = resourceCacheForEngine(engine);
      // A skybox frame changes only when the faces or the look direction do.
      presenter = createMaterialPreviewPresenter(host, canvas, {
        staticContent: true,
        suspended: overlay.isOpen,
      });
      if (!presenter) {
        overlay.dispose();
        host.dispose();
        return;
      }
      // Drag looks around the cube from its centre, like the other previews orbit.
      const look = presenter;
      gestures = attachMaterialPreviewGestures(canvas, host.camera, {
        onChange: () => look.present({ force: true }),
      });
      const faces = emptySkyboxFaces();
      const textureBytes = new Map<string, Uint8Array>();
      for (const key of SKYBOX_FACE_KEYS) {
        const guid = `skybox-creator-preview:${key}`;
        faces[key] = guid;
        textureBytes.set(guid, facePngs[key]!);
      }
      createSkyboxMeshForFaces(
        host.scene,
        "skybox-creator-preview",
        faces,
        DEFAULT_SKYBOX_SIZE,
        { textureBytes: installTextureBytes(textureBytes), resourceCache: cache },
      );
    } catch {
      overlay.dispose();
      gestures?.dispose();
      presenter?.dispose();
      host?.dispose();
      return;
    }
    const tick = () => {
      presenter?.present();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      gestures?.dispose();
      overlay.dispose();
      presenter?.dispose();
      host?.dispose();
    };
  }, [engine, faceKey, facePngs]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full cursor-grab touch-none rounded-md border border-border active:cursor-grabbing"
      data-testid={testId}
    />
  );
}

import { useEffect, useRef, useState } from "react";
import type { Engine } from "@babylonjs/core";
import {
  DEFAULT_SKYBOX_SIZE,
  SKYBOX_FACE_KEYS,
  emptySkyboxFaces,
  type SkyboxFaceKey,
} from "@babylonslate/core";
import {
  ResourceCache,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
  createSkyboxMeshForFaces,
} from "@babylonslate/render";
import { useOptionalPlay } from "../context/play-context";

export type SkyboxCreatorPreviewFacePngs = Record<SkyboxFaceKey, Uint8Array>;

function hideDefaultPreviewMesh(host: {
  mesh?: { setEnabled?: (enabled: boolean) => void; isVisible?: boolean };
}): void {
  const mesh = host.mesh;
  if (!mesh) return;
  mesh.setEnabled?.(false);
  if ("isVisible" in mesh) mesh.isVisible = false;
}

/** Live cubemap from in-memory sliced faces on the shared Engine. */
export function SkyboxCreatorPreviewCanvas({
  facePngs,
  testId = "skybox-creator-preview-canvas",
}: {
  facePngs: SkyboxCreatorPreviewFacePngs;
  testId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const [engine, setEngine] = useState<Engine | null>(null);
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
    let cache: ResourceCache | null = null;
    let frame = 0;
    try {
      host = createMaterialPreviewScene(engine);
      if (!host || cancelled) {
        host?.dispose();
        return;
      }
      hideDefaultPreviewMesh(host);
      cache = new ResourceCache();
      presenter = createMaterialPreviewPresenter(host, canvas);
      if (!presenter) {
        host.dispose();
        cache.dispose();
        return;
      }
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
        { textureBytes, resourceCache: cache },
      );
    } catch {
      presenter?.dispose();
      host?.dispose();
      cache?.dispose();
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
      presenter?.dispose();
      host?.dispose();
      cache?.dispose();
    };
  }, [engine, faceKey, facePngs]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full min-h-[160px] w-full rounded-md border border-border"
      data-testid={testId}
    />
  );
}

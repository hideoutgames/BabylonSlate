import { useEffect, useRef, useState } from "react";
import { Texture, type Engine } from "@babylonjs/core";
import {
  modelMaterialGuids,
  normalizeModelPayload,
} from "@babylonslate/assets";
import {
  MaterialLibrary,
  ResourceCache,
  applyModelMaterialSlots,
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  loadModelPreviewSource,
  materialUnavailable,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
} from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";

export function ModelPreviewCanvas({
  payload,
  sourceBytes,
}: {
  payload: Record<string, unknown>;
  sourceBytes: Uint8Array;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocuments();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const cacheRef = useRef<ResourceCache | null>(null);
  const model = normalizeModelPayload(payload);
  const slotKey = JSON.stringify(model.materialSlots);

  useEffect(() => {
    setEngine(play?.ensureSharedEngine() ?? null);
  }, [play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !engine) return;
    let cancelled = false;
    let host: MaterialPreviewScene | null = null;
    let presenter: MaterialPreviewPresenter | null = null;
    let gestures: { dispose: () => void } | null = null;
    let loaded: { dispose: () => void } | null = null;
    const raf = { id: 0 };
    void (async () => {
      try {
        host = createModelPreviewScene(engine);
        loaded = await loadModelPreviewSource(host, sourceBytes);
        if (cancelled || !host || !loaded) {
          host?.dispose();
          loaded?.dispose();
          return;
        }
        presenter = createMaterialPreviewPresenter(host, canvas, { maxFps: 1 });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
        });
        hostRef.current = host;
        presenterRef.current = presenter;
        presenter.present({ force: true });
        if (cancelled) {
          presenter.dispose();
          gestures.dispose();
          loaded.dispose();
          host.dispose();
          hostRef.current = null;
          presenterRef.current = null;
          return;
        }
        setPreviewGeneration((value) => value + 1);
        const tick = () => {
          if (cancelled) return;
          presenter?.present();
          raf.id = window.requestAnimationFrame(tick);
        };
        raf.id = window.requestAnimationFrame(tick);
      } catch {
        presenter?.dispose();
        gestures?.dispose();
        loaded?.dispose();
        host?.dispose();
        hostRef.current = null;
        presenterRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf.id);
      gestures?.dispose();
      presenter?.dispose();
      loaded?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
      cacheRef.current?.dispose();
      cacheRef.current = null;
    };
  }, [engine, sourceBytes]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !engine) return;
    let cancelled = false;
    const slots = JSON.parse(slotKey) as ReturnType<
      typeof normalizeModelPayload
    >["materialSlots"];
    void (async () => {
      const extraGuids = modelMaterialGuids({
        materialSlots: slots,
        clipNames: [],
      });
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
      if (cancelled || hostRef.current !== host) return;
      cacheRef.current?.dispose();
      const cache = new ResourceCache();
      cacheRef.current = cache;
      const library = new MaterialLibrary({
        functions: () => Object.fromEntries(materials.functions),
        resolveTexture: (guid) => {
          const data = textureBytes.get(guid);
          if (!data) return null;
          const texture = cache.getTexture(guid, engine, data);
          return texture instanceof Texture ? texture : null;
        },
      });
      for (const [guid, document] of materials.documents) {
        const acquired = library.acquire(host.scene, guid, document);
        if (materialUnavailable(acquired)) continue;
      }
      applyModelMaterialSlots(host.mesh, slots, (guid) =>
        library.materialFor(host.scene, guid),
      );
      presenterRef.current?.present({ force: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    collectPlayMaterialLibrary,
    collectPlayTextureBytes,
    engine,
    previewGeneration,
    slotKey,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full"
      data-testid="model-preview-canvas"
    />
  );
}

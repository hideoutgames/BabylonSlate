import { useEffect, useRef, useState } from "react";
import { type Engine } from "@babylonjs/core";
import {
  modelMaterialGuids,
  normalizeModelPayload,
} from "@babylonslate/assets";
import {
  MaterialLibrary,
  ViewportShadingOverlay,
  applyModelMaterialSlots,
  attachMaterialPreviewGestures,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  getMaterialTexture,
  loadModelPreviewSource,
  materialUnavailable,
  resourceCacheForEngine,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type ViewportShadingMode,
} from "@babylonslate/render";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";

const MODEL_PREVIEW_SHADING: { value: ViewportShadingMode; label: string }[] = [
  { value: "pbr", label: "PBR" },
  { value: "unlit", label: "Unlit" },
  { value: "wireframe", label: "Wireframe" },
];

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
  const { editorTextureLodEnabled, editorTextureLodQuality } =
    useEditorViewportPrefs();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const shadingRef = useRef<ViewportShadingOverlay | null>(null);
  const [shadingMode, setShadingMode] = useState<ViewportShadingMode>("pbr");
  const shadingModeRef = useRef(shadingMode);
  shadingModeRef.current = shadingMode;
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
        loaded = await loadModelPreviewSource(host, sourceBytes, model.importScale);
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
        const shading = new ViewportShadingOverlay(host.scene);
        shading.setMode(shadingModeRef.current);
        shadingRef.current = shading;
        presenter.present({ force: true });
        if (cancelled) {
          presenter.dispose();
          gestures.dispose();
          loaded.dispose();
          host.dispose();
          hostRef.current = null;
          presenterRef.current = null;
          shadingRef.current = null;
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
        shadingRef.current = null;
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
      shadingRef.current = null;
    };
  }, [engine, sourceBytes, model.importScale]);

  useEffect(() => {
    const overlay = shadingRef.current;
    if (!overlay) return;
    overlay.setMode(shadingMode);
    presenterRef.current?.present({ force: true });
  }, [shadingMode, previewGeneration]);

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
      const cache = resourceCacheForEngine(engine);
      const library = new MaterialLibrary({
        functions: () => Object.fromEntries(materials.functions),
        resolveTexture: (guid) => {
          const data = textureBytes.get(guid);
          if (!data) return null;
          return getMaterialTexture(cache, guid, engine, data);
        },
      });
      for (const [guid, document] of materials.documents) {
        const acquired = library.acquire(host.scene, guid, document);
        if (materialUnavailable(acquired)) continue;
      }
      applyModelMaterialSlots(host.mesh, slots, (guid) =>
        library.materialFor(host.scene, guid),
      );
      shadingRef.current?.apply();
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
    editorTextureLodEnabled,
    editorTextureLodQuality,
  ]);

  return (
    <div className="relative h-full min-h-0">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div
          className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
          data-testid="model-preview-shading"
        >
          <ToggleGroup
            variant="outline"
            size="touch"
            spacing={1}
            value={[shadingMode]}
            onValueChange={(value) => {
              const next = value[0] as ViewportShadingMode | undefined;
              if (!next) return;
              setShadingMode(next);
            }}
            aria-label="Preview Shading"
          >
            {MODEL_PREVIEW_SHADING.map((mode) => (
              <ToggleGroupItem
                key={mode.value}
                value={mode.value}
                data-testid={`model-preview-shading-${mode.value}`}
              >
                {mode.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        data-testid="model-preview-canvas"
      />
    </div>
  );
}

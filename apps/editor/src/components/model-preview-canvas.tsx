import { useEffect, useRef, useState } from "react";
import { Mesh, Quaternion, type Engine } from "@babylonjs/core";
import {
  modelMaterialGuids,
  normalizeModelPayload,
  simpleColliderToPhysicsShape,
  type ModelSimpleCollider,
} from "@babylonslate/assets";
import type { ColliderShape } from "@babylonslate/physics";
import {
  MaterialLibrary,
  ViewportShadingOverlay,
  applyModelMaterialSlots,
  attachMaterialPreviewGestures,
  createColliderVisualMesh,
  createGizmoHost,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  getMaterialTexture,
  isColliderVisualMesh,
  loadModelPreviewSource,
  materialUnavailable,
  resourceCacheForEngine,
  type GizmoHost,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type ViewportShadingMode,
} from "@babylonslate/render";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { useDocuments } from "../context/document-context";
import { useOptionalPlay } from "../context/play-context";
import { useModelColliderSession } from "../context/model-collider-session";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";

const MODEL_PREVIEW_SHADING: { value: ViewportShadingMode; label: string }[] = [
  { value: "pbr", label: "PBR" },
  { value: "unlit", label: "Unlit" },
  { value: "wireframe", label: "Wireframe" },
];

const MODEL_PREVIEW_GIZMO_TOOLS: {
  value: "translate" | "rotate" | "scale";
  label: string;
}[] = [
  { value: "translate", label: "Move" },
  { value: "rotate", label: "Rotate" },
  { value: "scale", label: "Scale" },
];

export function ModelPreviewCanvas({
  payload,
  sourceBytes,
  onChange,
}: {
  payload: Record<string, unknown>;
  sourceBytes: Uint8Array;
  onChange?: (next: Record<string, unknown>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const {
    selectedColliderId,
    setSelectedColliderId,
    showCollision,
    setShowCollision,
    gizmoTool,
    setGizmoTool,
  } = useModelColliderSession();
  const { collectPlayMaterialLibrary, collectPlayTextureBytes } = useDocuments();
  const { editorTextureLodEnabled, editorTextureLodQuality } =
    useEditorViewportPrefs();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const shadingRef = useRef<ViewportShadingOverlay | null>(null);
  const gizmoHostRef = useRef<GizmoHost | null>(null);
  const colliderVisualsRef = useRef(new Map<string, Mesh>());
  const model = normalizeModelPayload(payload);
  const modelRef = useRef(model);
  modelRef.current = model;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selectedColliderIdRef = useRef(selectedColliderId);
  selectedColliderIdRef.current = selectedColliderId;
  const [shadingMode, setShadingMode] = useState<ViewportShadingMode>("pbr");
  const shadingModeRef = useRef(shadingMode);
  shadingModeRef.current = shadingMode;
  const slotKey = JSON.stringify(model.materialSlots);
  const colliderKey = JSON.stringify(model.simpleColliders);

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
    const visuals = colliderVisualsRef.current;
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
        const gizmos = createGizmoHost(host.scene, {
          tool: "translate",
          onDrag: () => presenter?.present({ force: true }),
          onDragEnd: () => {
            const attached = gizmos.attachedMesh();
            const id = selectedColliderIdRef.current;
            const current = modelRef.current;
            if (!attached || !id || !onChangeRef.current) return;
            const rotation = attached.rotationQuaternion;
            onChangeRef.current({
              ...current,
              simpleColliders: current.simpleColliders.map((collider) =>
                collider.id === id
                  ? {
                      ...collider,
                      position: [
                        attached.position.x,
                        attached.position.y,
                        attached.position.z,
                      ],
                      rotation: rotation
                        ? [rotation.x, rotation.y, rotation.z, rotation.w]
                        : collider.rotation,
                      scale: [
                        attached.scaling.x,
                        attached.scaling.y,
                        attached.scaling.z,
                      ],
                    }
                  : collider,
              ),
            });
            presenter?.present({ force: true });
          },
        });
        gizmoHostRef.current = gizmos;
        const pointerCanvas = () => ({
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
          blockOrbit: (x, y) =>
            gizmos.isDragging() || gizmos.hitTest(x, y, pointerCanvas()),
          onPointer: (type, x, y, pointerId) => {
            gizmos.forwardPointer(type, x, y, { ...pointerCanvas(), pointerId });
          },
          onTap: (x, y) => {
            const pick = host.scene.pick(x, y);
            let node = pick?.pickedMesh ?? null;
            while (node) {
              if (node instanceof Mesh && isColliderVisualMesh(node)) {
                const id = (
                  node.metadata as { modelColliderId?: string } | null
                )?.modelColliderId;
                if (id) {
                  setSelectedColliderId(id);
                  return;
                }
              }
              node = node.parent as typeof node;
            }
            setSelectedColliderId(null);
          },
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
          gizmoHostRef.current?.dispose();
          gizmoHostRef.current = null;
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
        gizmoHostRef.current?.dispose();
        gizmoHostRef.current = null;
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
      gizmoHostRef.current?.dispose();
      gizmoHostRef.current = null;
      visuals.forEach((visual) => visual.dispose());
      visuals.clear();
    };
  }, [engine, sourceBytes, model.importScale, setSelectedColliderId]);

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

  useEffect(() => {
    const host = hostRef.current;
    const gizmos = gizmoHostRef.current;
    const visuals = colliderVisualsRef.current;
    if (!host) return;
    gizmos?.attachTo(null);
    if (showCollision) {
      const colliders = JSON.parse(colliderKey) as ModelSimpleCollider[];
      for (const collider of colliders) {
        const visual = createColliderVisualMesh(
          host.scene,
          `model-collider:${collider.id}_overlay`,
          simpleColliderToPhysicsShape(collider) as ColliderShape,
          undefined,
          { pickable: true },
        );
        visual.parent = host.mesh;
        visual.metadata = {
          ...(typeof visual.metadata === "object" && visual.metadata
            ? visual.metadata
            : {}),
          modelColliderId: collider.id,
        };
        visual.position.set(
          collider.position[0],
          collider.position[1],
          collider.position[2],
        );
        visual.rotationQuaternion = new Quaternion(
          collider.rotation[0],
          collider.rotation[1],
          collider.rotation[2],
          collider.rotation[3],
        );
        visual.scaling.set(collider.scale[0], collider.scale[1], collider.scale[2]);
        visuals.set(collider.id, visual);
      }
      const selected = selectedColliderId
        ? visuals.get(selectedColliderId)
        : undefined;
      if (selected) {
        gizmos?.attachTo(selected);
        gizmos?.setTool(gizmoTool);
      }
    }
    presenterRef.current?.present({ force: true });
    return () => {
      visuals.forEach((visual) => visual.dispose());
      visuals.clear();
      gizmos?.attachTo(null);
    };
  }, [
    colliderKey,
    gizmoTool,
    previewGeneration,
    selectedColliderId,
    showCollision,
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
          <Toggle
            size="sm"
            variant="outline"
            pressed={showCollision}
            onPressedChange={setShowCollision}
            aria-label="Show Collision"
            data-testid="model-show-collision"
          >
            Show Collision
          </Toggle>
          {selectedColliderId ? (
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={[gizmoTool]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "translate" || next === "rotate" || next === "scale") {
                  setGizmoTool(next);
                }
              }}
              aria-label="Collider Transform Tool"
              data-testid="model-collider-gizmo-tools"
            >
              {MODEL_PREVIEW_GIZMO_TOOLS.map((tool) => (
                <ToggleGroupItem
                  key={tool.value}
                  value={tool.value}
                  aria-label={tool.label}
                  data-testid={`model-collider-gizmo-${tool.value}`}
                >
                  {tool.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
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

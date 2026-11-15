import { useEffect, useRef, useState } from "react";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { SkeletonKind, SkeletonSocket } from "@haptic/assets";
import {
  attachMaterialPreviewGestures,
  attachSkeletonPreview,
  attachSkeletonSocketPreview,
  createGizmoHost,
  createMaterialPreviewPresenter,
  createModelPreviewScene,
  installPreviewEnvironment,
  setSceneRenderSettings,
  loadModelPreviewSource,
  previewRigRoot,
  type GizmoHost,
  type MaterialPreviewPresenter,
  type MaterialPreviewScene,
  type SkeletonPreviewHandle,
  type SkeletonSocketPreviewHandle,
} from "@haptic/render";
import { useOptionalPlay } from "../context/play-context";
import { useProjectState } from "../context/document-context";
import { watchBlockingEditorOverlay } from "../lib/viewport-render-gate";

/**
 * The Skeleton's rig at rest, with its sockets as markers on their bones. Tap a marker to select its socket; the
 * selected socket's gizmo moves it in its bone's space.
 */
export function SkeletonPreviewCanvas({
  sourceBytes,
  kind,
  selectedBone = null,
  sockets = [],
  selectedSocket = null,
  onSelectSocket,
  onMoveSocket,
}: {
  sourceBytes: Uint8Array;
  kind: SkeletonKind;
  /** The bone drawn in the selection colour. */
  selectedBone?: string | null;
  sockets?: readonly SkeletonSocket[];
  /** The socket drawn in the selection colour, with the gizmo on it. */
  selectedSocket?: string | null;
  /** A tap picked a socket's marker, or empty space (null). */
  onSelectSocket?: (name: string | null) => void;
  /** The gizmo moved a socket: its new position in its bone's space. */
  onMoveSocket?: (name: string, position: [number, number, number]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const play = useOptionalPlay();
  const { projectDocument } = useProjectState();
  const [engine, setEngine] = useState<AbstractEngine | null>(null);
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [bonesAttached, setBonesAttached] = useState(false);
  const hostRef = useRef<MaterialPreviewScene | null>(null);
  const presenterRef = useRef<MaterialPreviewPresenter | null>(null);
  const bonesRef = useRef<SkeletonPreviewHandle | null>(null);
  const socketsRef = useRef<SkeletonSocketPreviewHandle | null>(null);
  const gizmoRef = useRef<GizmoHost | null>(null);
  const selectedBoneRef = useRef(selectedBone);
  selectedBoneRef.current = selectedBone;
  const selectedSocketRef = useRef(selectedSocket);
  selectedSocketRef.current = selectedSocket;
  const callbacksRef = useRef({ onSelectSocket, onMoveSocket });
  callbacksRef.current = { onSelectSocket, onMoveSocket };
  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      setSceneRenderSettings(host.scene, projectDocument?.settings.render ?? {});
      presenterRef.current?.present({ force: true });
    }
  }, [projectDocument?.settings.render, previewGeneration]);

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
    let gizmos: GizmoHost | null = null;
    const raf = { id: 0 };
    const overlay = watchBlockingEditorOverlay();
    void (async () => {
      try {
        host = createModelPreviewScene(engine);
        installPreviewEnvironment(host.scene);
        loaded = await loadModelPreviewSource(host, sourceBytes);
        if (cancelled || !host || !loaded) {
          host?.dispose();
          loaded?.dispose();
          return;
        }
        // The rig is shown at rest: no animation runs here, so the frame only changes on the redraws requested below.
        presenter = createMaterialPreviewPresenter(host, canvas, {
          maxFps: 30,
          staticContent: true,
          // Gizmo handles draw on their own utility layer, whose shaders the Scene's readiness does not cover.
          settleWhen: () => !gizmoRef.current?.attachedMesh(),
          suspended: overlay.isOpen,
        });
        const previewHost = host;
        const handles = createGizmoHost(host.scene, {
          tool: "translate",
          // The preview draws through its renderer's graph: handles join it as an editor overlay.
          registerOverlay: (draw) => previewHost.renderer.attachEditorOverlay(draw),
          onDrag: () => presenter?.present({ force: true }),
          onDragEnd: () => {
            const name = selectedSocketRef.current;
            const offset = name ? socketsRef.current?.offsetOf(name) : null;
            if (name && offset) callbacksRef.current.onMoveSocket?.(name, offset.position);
            presenter?.present({ force: true });
          },
        });
        gizmos = handles;
        gizmoRef.current = handles;
        const pointerCanvas = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
        gestures = attachMaterialPreviewGestures(canvas, host.camera, {
          onChange: () => presenter?.present({ force: true }),
          blockOrbit: (x, y) => handles.isDragging() || handles.hitTest(x, y, pointerCanvas()),
          onPointer: (type, x, y, pointerId) => {
            handles.forwardPointer(type, x, y, { ...pointerCanvas(), pointerId });
            if (type !== "move") presenter?.present({ force: true });
          },
          onTap: (x, y) => {
            const pick = host?.scene.pick(x, y, (mesh) => socketsRef.current?.socketOf(mesh) != null);
            const name = pick?.pickedMesh ? socketsRef.current?.socketOf(pick.pickedMesh) ?? null : null;
            callbacksRef.current.onSelectSocket?.(name);
          },
        });
        hostRef.current = host;
        presenterRef.current = presenter;
        // The generation effects attach the bones and sockets and apply the render settings, then redraw.
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
        gizmos?.dispose();
        loaded?.dispose();
        host?.dispose();
        hostRef.current = null;
        presenterRef.current = null;
        gizmoRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf.id);
      overlay.dispose();
      bonesRef.current?.dispose();
      bonesRef.current = null;
      socketsRef.current?.dispose();
      socketsRef.current = null;
      gestures?.dispose();
      gizmos?.dispose();
      gizmoRef.current = null;
      presenter?.dispose();
      loaded?.dispose();
      host?.dispose();
      hostRef.current = null;
      presenterRef.current = null;
    };
  }, [engine, sourceBytes]);

  useEffect(() => {
    const host = hostRef.current;
    bonesRef.current?.dispose();
    bonesRef.current = null;
    setBonesAttached(false);
    if (!host) {
      presenterRef.current?.present({ force: true });
      return;
    }
    bonesRef.current = attachSkeletonPreview(
      previewRigRoot(host),
      host.scene,
      kind,
    );
    bonesRef.current.setSelectedBone(selectedBoneRef.current);
    setBonesAttached(true);
    presenterRef.current?.present({ force: true });
  }, [kind, previewGeneration]);

  useEffect(() => {
    bonesRef.current?.setSelectedBone(selectedBone);
    presenterRef.current?.present({ force: true });
  }, [selectedBone]);

  // Markers follow the Skeleton's sockets; the gizmo sits on the selected one.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    gizmoRef.current?.attachTo(null);
    if (socketsRef.current) socketsRef.current.setSockets(sockets);
    else socketsRef.current = attachSkeletonSocketPreview(previewRigRoot(host), host.scene, sockets);
    socketsRef.current.setSelected(selectedSocket);
    const marker = selectedSocket ? socketsRef.current.marker(selectedSocket) : null;
    gizmoRef.current?.attachTo(marker);
    if (marker) gizmoRef.current?.setTool("translate");
    presenterRef.current?.present({ force: true });
  }, [sockets, selectedSocket, previewGeneration]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      data-testid="skeleton-preview-canvas"
      data-bones={bonesAttached ? "true" : "false"}
      data-selected-bone={selectedBone ?? undefined}
      data-sockets={String(sockets.length)}
      data-selected-socket={selectedSocket ?? undefined}
    />
  );
}

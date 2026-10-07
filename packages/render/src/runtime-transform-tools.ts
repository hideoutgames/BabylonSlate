import { Matrix, Mesh, Quaternion, Vector3, type AbstractMesh, type Camera, type Scene } from "@babylonjs/core";
import type { RuntimeObjectIdentity } from "@babylonslate/bridge";
import type { SerializedTransform, ViewportMode } from "@babylonslate/core";
import { createGizmoHost, type GizmoSnapSettings, type GizmoTool } from "./gizmo-host";
import { markEditorHelperMesh } from "./helper-mesh";
import type { PointerCanvasSize } from "./pick-coords";
import type { RenderScheduler } from "./render-scheduler";

export interface RuntimeTransformChange {
  target: RuntimeObjectIdentity;
  transform: SerializedTransform;
  /** Absolute world pose; the runtime converts it against authoritative parents. */
  space: "world";
  phase: "continuous" | "commit";
}
export interface RuntimeTransformToolsOptions {
  onPick: (target: { actorGuid: string; slotId: number } | null) => void;
  onTransform: (change: RuntimeTransformChange) => Promise<unknown>;
  onSelectionLost?: (target: RuntimeObjectIdentity, reason: string) => void;
  onError?: (reason: string) => void;
}
export interface RuntimeTransformTools {
  setSelection: (identity: RuntimeObjectIdentity | null, options?: {
    slotId?: number; writable?: boolean; worldTransform?: SerializedTransform;
  }) => { accepted: boolean; reason?: string };
  setEnabled: (enabled: boolean) => void;
  setTool: (tool: GizmoTool) => void;
  setSnap: (settings: GizmoSnapSettings) => void;
  dispose: () => void;
}
export interface RuntimeTransformToolsOwner extends RuntimeTransformTools {
  blocksCameraPointer: (x: number, y: number) => boolean;
  actorRemoved: (actorGuid: string, slotId: number) => void;
  clear: () => void;
}
export interface RuntimeTransformBinding {
  slotId: number;
  /** Identity is checked again for every gesture and selected-owner redraw. */
  isCurrent: () => boolean;
  mesh: AbstractMesh | null;
  visuals: AbstractMesh[];
}
type Host = {
  mode: ViewportMode;
  scheduler: Pick<RenderScheduler, "acquireContinuous">;
  requestRedraw: () => void;
  pointerCanvas: () => PointerCanvasSize;
  cameraGestureActive: () => boolean;
  resolve: (identity: RuntimeObjectIdentity, slotId: number | undefined) => RuntimeTransformBinding | null;
  pick: (x: number, y: number) => { actorGuid: string; slotId: number } | null;
  selectVisuals: (meshes: AbstractMesh[]) => void;
  registerOverlay: (draw: (camera: Camera) => void) => () => void;
  forwardPointers: boolean;
};

const identityKey = (identity: RuntimeObjectIdentity) => JSON.stringify([
  identity.sceneInstanceId, identity.actorGuid, identity.actorToken,
  identity.componentGuid ?? null, identity.componentToken ?? null,
]);

/** Existing gizmos manipulate a session-owned draft proxy. Only a typed,
 * acknowledged runtime mutation changes the real actor/component pose. */
export function createRuntimeTransformTools(
  scene: Scene, canvas: HTMLCanvasElement, host: Host, callbacks: RuntimeTransformToolsOptions,
): RuntimeTransformToolsOwner {
  let enabled = false;
  let disposed = false;
  let selected: RuntimeObjectIdentity | null = null;
  let selectedKey: string | null = null;
  let selectedSlot: number | undefined;
  let inspectedWorldPose: SerializedTransform | undefined;
  let binding: RuntimeTransformBinding | null = null;
  let writable = true;
  let poseAvailable = false;
  let lost = false;
  let pendingCommit = false;
  let suppressCommit = false;
  let revision = 0;
  let pointer: { id: number; x: number; y: number; moved: boolean; gizmo: boolean } | null = null;
  let tool: GizmoTool = "translate";
  const proxy = new Mesh("simulation-transform-draft", scene);
  proxy.isVisible = false;
  proxy.isPickable = false;
  proxy.rotationQuaternion = Quaternion.Identity();
  markEditorHelperMesh(proxy);
  const scale = new Vector3();
  const rotation = new Quaternion();
  const position = new Vector3();
  const matrix = new Matrix();

  const setPose = (value: SerializedTransform) => {
    proxy.position.copyFromFloats(...value.position);
    proxy.rotationQuaternion!.copyFromFloats(...value.rotation);
    proxy.scaling.copyFromFloats(...value.scale);
    proxy.computeWorldMatrix(true);
    poseAvailable = true;
  };
  const readPose = (): SerializedTransform => ({
    position: [proxy.position.x, proxy.position.y, proxy.position.z],
    rotation: [proxy.rotationQuaternion!.x, proxy.rotationQuaternion!.y, proxy.rotationQuaternion!.z, proxy.rotationQuaternion!.w],
    scale: [proxy.scaling.x, proxy.scaling.y, proxy.scaling.z],
  });
  const current = () => !lost && poseAvailable && !!selected && !!binding && binding.isCurrent() && !binding.mesh?.isDisposed();
  const follow = () => {
    if (!binding?.mesh || gizmos.isDragging() || pendingCommit) return;
    // Scene meshes remain in absolute world space. Babylon subtracts its
    // floating origin only at shader submission; adding it here would double it.
    matrix.copyFrom(binding.mesh.computeWorldMatrix(true));
    if (!matrix.decompose(scale, rotation, position)) return;
    proxy.position.copyFrom(position);
    proxy.rotationQuaternion!.copyFrom(rotation);
    proxy.scaling.copyFrom(scale);
    proxy.computeWorldMatrix(true);
    poseAvailable = true;
  };
  const emit = (phase: RuntimeTransformChange["phase"]) => {
    if (suppressCommit || !enabled || !writable) return;
    // A draft belongs to its original native owner. Rebind the same exact
    // runtime identity, but never send the stale owner's final gesture value.
    if (!current()) { refreshBinding(); return; }
    const target = selected!;
    const requestRevision = ++revision;
    if (phase === "commit") pendingCommit = true;
    let result: Promise<unknown>;
    try { result = callbacks.onTransform({ target, transform: readPose(), space: "world", phase }); }
    catch (error) { result = Promise.reject(error); }
    void result.catch((error: unknown) => {
      if (!disposed && revision === requestRevision) callbacks.onError?.(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (disposed || revision !== requestRevision || phase !== "commit") return;
      pendingCommit = false;
      follow();
      host.requestRedraw();
    });
  };
  const gizmos = createGizmoHost(scene, {
    mode: host.mode,
    scheduler: { acquireContinuous: (reason) => host.scheduler.acquireContinuous(reason), invalidate: () => host.requestRedraw() },
    registerOverlay: (draw) => host.registerOverlay((camera) => {
      if (!enabled || !selected || lost || !poseAvailable) return;
      if (!current() && !refreshBinding()) return;
      follow();
      draw(camera);
    }),
    onDragStart: () => { pendingCommit = false; revision++; },
    onDrag: () => { emit("continuous"); host.requestRedraw(); },
    onDragEnd: () => { emit("commit"); host.requestRedraw(); },
  });
  const axes = [gizmos.positionGizmo.xGizmo, gizmos.positionGizmo.yGizmo, gizmos.positionGizmo.zGizmo,
    gizmos.positionGizmo.xPlaneGizmo, gizmos.positionGizmo.yPlaneGizmo, gizmos.positionGizmo.zPlaneGizmo,
    gizmos.rotationGizmo.xGizmo, gizmos.rotationGizmo.yGizmo, gizmos.rotationGizmo.zGizmo,
    gizmos.scaleGizmo.xGizmo, gizmos.scaleGizmo.yGizmo, gizmos.scaleGizmo.zGizmo, gizmos.scaleGizmo.uniformScaleGizmo];
  const cancelGesture = () => {
    suppressCommit = true;
    try {
      for (const axis of axes) axis.dragBehavior.releaseDrag();
      if (pointer) {
        if (host.forwardPointers && pointer.gizmo) gizmos.forwardPointer("up", pointer.x, pointer.y, { ...host.pointerCanvas(), pointerId: pointer.id });
        const id = pointer.id;
        pointer = null;
        try { canvas.releasePointerCapture?.(id); } catch { /* Already released. */ }
      }
    } finally { suppressCommit = false; }
  };
  const attach = () => {
    gizmos.setTool(tool);
    gizmos.attachTo(enabled && writable && current() ? proxy : null);
    host.selectVisuals(enabled && current() ? binding!.visuals : []);
    host.requestRedraw();
  };
  function loseSelection(reason: string) {
    if (lost) return;
    lost = true;
    const target = selected;
    cancelGesture();
    revision++;
    pendingCommit = false;
    binding = null;
    gizmos.attachTo(null);
    host.selectVisuals([]);
    if (target) callbacks.onSelectionLost?.(target, reason);
    // Keep its key until an explicit selection change; recycled slots/meshes
    // must never silently revive a destroyed selection during a poll.
  }
  function refreshBinding(): boolean {
    if (lost || !selected) return false;
    if (current()) return true;
    // The host validates scene instance, slot, actor token, and component token.
    // A mesh replacement is not an actor destruction or a new selection.
    const replacement = host.resolve(selected, selectedSlot);
    if (!replacement?.isCurrent() || replacement.mesh?.isDisposed()) {
      loseSelection("The selected runtime object was destroyed or is unavailable.");
      return false;
    }
    cancelGesture();
    revision++;
    pendingCommit = false;
    binding = replacement;
    poseAvailable = false;
    if (binding.mesh) follow();
    else if (inspectedWorldPose) setPose(inspectedWorldPose);
    attach();
    return current();
  }
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const blocksCameraPointer = (x: number, y: number) => enabled && !disposed &&
    (gizmos.isDragging() || (writable && current() && gizmos.hitTest(x, y, host.pointerCanvas())));
  const down = (event: PointerEvent) => {
    if (!enabled || disposed || pointer || event.button !== 0) return;
    const p = point(event);
    const hitGizmo = blocksCameraPointer(p.x, p.y);
    if (hitGizmo && host.cameraGestureActive()) return;
    pointer = { id: event.pointerId, ...p, moved: false, gizmo: hitGizmo };
    if (!hitGizmo) return;
    event.preventDefault();
    canvas.focus?.({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    if (host.forwardPointers) gizmos.forwardPointer("down", p.x, p.y, { ...host.pointerCanvas(), pointerId: event.pointerId });
  };
  const move = (event: PointerEvent) => {
    if (!enabled || pointer?.id !== event.pointerId) return;
    const p = point(event);
    pointer.moved ||= Math.hypot(p.x - pointer.x, p.y - pointer.y) > 6;
    if (pointer.gizmo && host.forwardPointers) gizmos.forwardPointer("move", p.x, p.y, { ...host.pointerCanvas(), pointerId: event.pointerId });
  };
  const up = (event: PointerEvent) => {
    if (!enabled || pointer?.id !== event.pointerId) return;
    const gesture = pointer;
    const p = point(event);
    pointer = null;
    if (gesture.gizmo) {
      if (host.forwardPointers) gizmos.forwardPointer("up", p.x, p.y, { ...host.pointerCanvas(), pointerId: event.pointerId });
    } else if (!gesture.moved) callbacks.onPick(host.pick(p.x, p.y));
  };
  const cancel = (event: PointerEvent) => { if (pointer?.id === event.pointerId) cancelGesture(); };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("lostpointercapture", cancel);
  canvas.addEventListener("blur", cancelGesture);

  return {
    setSelection: (identity, options = {}) => {
      if (disposed) return { accepted: false, reason: "Runtime transform tools were disposed." };
      const key = identity ? identityKey(identity) : null;
      if (key === selectedKey) {
        writable = options.writable !== false;
        if (options.slotId !== undefined) selectedSlot = options.slotId;
        if (options.worldTransform) inspectedWorldPose = options.worldTransform;
        if (!lost && binding && !current()) refreshBinding();
        if (!lost && !binding && identity) binding = host.resolve(identity, options.slotId);
        if (!lost && binding?.mesh && !poseAvailable) follow();
        if (!lost && !pendingCommit && !gizmos.isDragging() && options.worldTransform && !binding?.mesh) setPose(options.worldTransform);
        attach();
        return current() ? { accepted: true } : { accepted: identity === null, reason: "The selected runtime object is unavailable." };
      }
      cancelGesture();
      revision++;
      pendingCommit = false;
      selected = identity;
      selectedKey = key;
      selectedSlot = options.slotId;
      inspectedWorldPose = options.worldTransform;
      poseAvailable = false;
      lost = false;
      binding = identity ? host.resolve(identity, options.slotId) : null;
      writable = options.writable !== false;
      if (options.worldTransform) setPose(options.worldTransform);
      else if (binding?.mesh) follow();
      else if (identity) { attach(); return { accepted: false, reason: "The selected object has no render pose; wait for runtime inspection." }; }
      attach();
      return identity && !current() ? { accepted: false, reason: "The selected runtime object is unavailable." } : { accepted: true };
    },
    setEnabled: (value) => { if (disposed || enabled === value) return; cancelGesture(); enabled = value; attach(); },
    setTool: (value) => { if (disposed) return; cancelGesture(); tool = value; attach(); },
    setSnap: (value) => { if (!disposed) gizmos.setSnap(value); },
    blocksCameraPointer,
    actorRemoved: (actorGuid, slotId) => { if (selected?.actorGuid === actorGuid && binding?.slotId === slotId) loseSelection("The selected runtime actor was destroyed."); },
    clear: () => { if (selected) loseSelection("The runtime scene was replaced."); },
    dispose: () => {
      if (disposed) return;
      cancelGesture();
      disposed = true;
      revision++;
      host.selectVisuals([]);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      canvas.removeEventListener("blur", cancelGesture);
      gizmos.dispose();
      proxy.dispose();
    },
  };
}

import { FreeCamera, MeshBuilder, Quaternion, Vector3 } from "@babylonjs/core";
import type { RuntimeObjectIdentity } from "@babylonslate/bridge";
import { afterEach, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import * as gizmoModule from "./gizmo-host";
import { createRuntimeTransformTools, type RuntimeTransformChange } from "./runtime-transform-tools";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function fixture() {
  const { engine, scene } = createTestEngine();
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("camera", new Vector3(1_000_000, 0, -10), scene);
  scene.activeCamera = camera;
  const canvas = new EventTarget() as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  const target = MeshBuilder.CreateBox("actor", {}, scene);
  target.position.set(1_000_000.25, 2, 3);
  target.rotationQuaternion = Quaternion.Identity();
  const identity: RuntimeObjectIdentity = { sceneInstanceId: "scene:a:1", actorGuid: "actor", actorToken: 7 };
  let liveTarget = target;
  let liveToken = identity.actorToken;
  const created = vi.spyOn(gizmoModule, "createGizmoHost"); // Retains the real Babylon gizmos.
  const writes: RuntimeTransformChange[] = [];
  const lost = vi.fn();
  let finishCommit: (() => void) | undefined;
  const owner = createRuntimeTransformTools(scene, canvas, {
    mode: "3d", scheduler: { acquireContinuous: () => () => {} }, requestRedraw: () => {},
    pointerCanvas: () => ({ width: 800, height: 600 }), cameraGestureActive: () => false,
    forwardPointers: true, pick: () => null, selectVisuals: () => {}, registerOverlay: () => () => {},
    resolve: (selection, slot) => {
      const resolved = liveTarget;
      return selection.actorToken === liveToken && selection.sceneInstanceId === identity.sceneInstanceId && slot === 3
        ? { slotId: 3, mesh: resolved, visuals: [resolved],
          isCurrent: () => selection.actorToken === liveToken && liveTarget === resolved && !resolved.isDisposed() } : null;
    },
  }, {
    onPick: () => {}, onSelectionLost: lost,
    onTransform: (change) => {
      writes.push(change);
      return change.phase === "commit" ? new Promise<void>((resolve) => { finishCommit = resolve; }) : Promise.resolve();
    },
  });
  cleanups.push(owner.dispose);
  const gizmos = created.mock.results[0]!.value as gizmoModule.GizmoHost;
  owner.setSelection(identity, { slotId: 3 });
  owner.setEnabled(true);
  const drag = gizmos.positionGizmo.xGizmo.dragBehavior;
  const start = () => {
    drag.dragging = true;
    drag.onDragStartObservable.notifyObservers({ dragPlanePoint: Vector3.Zero(), pointerId: 1, pointerInfo: null });
  };
  return { scene, target, identity, owner, gizmos, writes, lost, drag, start,
    replaceVisual: (newActor = false) => {
      const next = MeshBuilder.CreateBox("replacement", {}, scene);
      next.position.set(10, 20, 30);
      if (newActor) liveToken++;
      liveTarget.dispose();
      liveTarget = next;
      return next;
    },
    finishCommit: () => finishCommit?.() };
}

it("moves a draft with absolute world coordinates and waits for the runtime acknowledgement", async () => {
  const { target, identity, gizmos, writes, drag, start, finishCommit } = fixture();
  const proxy = gizmos.attachedMesh()!;
  expect(proxy).not.toBe(target);
  expect(proxy.position.x).toBe(1_000_000.25);
  start();
  // Let Babylon's real drag observer update the draft matrix before the adapter
  // reads it. The authoritative render mesh must remain untouched.
  drag.onDragObservable.notifyObservers({ delta: new Vector3(5, 0, 0), dragPlanePoint: new Vector3(5, 0, 0),
    dragPlaneNormal: Vector3.Forward(), dragDistance: 5, pointerId: 1, pointerInfo: null });
  expect(writes.at(-1)).toMatchObject({ target: identity, space: "world", phase: "continuous",
    transform: { position: [1_000_005.25, 2, 3] } });
  expect(target.position.x).toBe(1_000_000.25);
  drag.releaseDrag();
  expect(writes.at(-1)?.phase).toBe("commit");
  expect(proxy.position.x).toBe(1_000_005.25);
  target.position.x = 1_000_006.25; // Effective authoritative snapshot can differ.
  finishCommit();
  await Promise.resolve();
  await Promise.resolve();
  expect(proxy.position.x).toBe(1_000_006.25);
});

it("cancels an active gesture on Edit exit without issuing a final write", () => {
  const { owner, gizmos, start, writes } = fixture();
  start();
  expect(gizmos.isDragging()).toBe(true);
  owner.setEnabled(false);
  expect(gizmos.isDragging()).toBe(false);
  expect(gizmos.attachedMesh()).toBeNull();
  expect(writes).toHaveLength(0);
  owner.setEnabled(true);
  expect(gizmos.attachedMesh()).not.toBeNull();
});

it("loses a destroyed selection once and refuses to revive it from a stale identity", () => {
  const { owner, target, identity, gizmos, lost } = fixture();
  target.dispose();
  owner.actorRemoved(identity.actorGuid, 3);
  owner.actorRemoved(identity.actorGuid, 3);
  expect(lost).toHaveBeenCalledOnce();
  expect(gizmos.attachedMesh()).toBeNull();
  expect(owner.setSelection(identity, { slotId: 3 }).accepted).toBe(false);
  expect(owner.setSelection({ ...identity, actorToken: 8 }, { slotId: 3 }).accepted).toBe(false);
  owner.dispose();
  expect(gizmos.layer.utilityLayerScene.isDisposed).toBe(true);
});

it("rebinds a replacement visual with the same runtime token and cancels its predecessor's drag", () => {
  const { identity, owner, gizmos, lost, start, drag, writes, replaceVisual } = fixture();
  start();
  const replacement = replaceVisual();
  expect(owner.setSelection(identity, { slotId: 3 }).accepted).toBe(true);
  expect(lost).not.toHaveBeenCalled();
  expect(gizmos.isDragging()).toBe(false);
  expect(writes).toHaveLength(0);
  expect(gizmos.attachedMesh()!.position.asArray()).toEqual([10, 20, 30]);
  start();
  drag.onDragObservable.notifyObservers({ delta: new Vector3(2, 0, 0), dragPlanePoint: new Vector3(2, 0, 0),
    dragPlaneNormal: Vector3.Forward(), dragDistance: 2, pointerId: 1, pointerInfo: null });
  expect(writes.at(-1)?.transform.position).toEqual([12, 20, 30]);
  expect(replacement.position.asArray()).toEqual([10, 20, 30]);
});

it("does not rebind a recycled slot whose actor lifetime changed", () => {
  const { identity, owner, gizmos, lost, replaceVisual } = fixture();
  replaceVisual(true);
  expect(owner.setSelection(identity, { slotId: 3 }).accepted).toBe(false);
  expect(lost).toHaveBeenCalledOnce();
  expect(gizmos.attachedMesh()).toBeNull();
});

import { Matrix, Vector3 } from "@babylonjs/core";
import { joystick2DValue, type OverlayPointerHit } from "@babylonslate/core";
import { joystick2DMesh, type Joystick2DMesh } from "./joystick2d-mesh";
import type { SceneLayerView } from "./scene-layer-compositor";

type Capture = { visual: Joystick2DMesh; layer: SceneLayerView; x: number; y: number };

// Pointer moves arrive many times per frame; reuse the projection scratch.
const scratchWorld = new Vector3();
const scratchLocal = new Vector3();
const scratchInverse = new Matrix();

/** Pointer ownership and axis aggregation shared by editor Play and the player. */
export class Joystick2DInput {
  private readonly captures = new Map<number, Capture>();
  private readonly ignoredPointers = new Set<number>();
  private emitted = new Map<string, number>();
  private readonly layerFor: (id: string) => SceneLayerView | undefined;
  private readonly size: () => { width: number; height: number };
  private readonly emit: (controlId: string, value: number) => void;

  constructor(
    layerFor: (id: string) => SceneLayerView | undefined,
    size: () => { width: number; height: number },
    emit: (controlId: string, value: number) => void,
  ) {
    this.layerFor = layerFor;
    this.size = size;
    this.emit = emit;
  }

  owns(pointerId: number): boolean {
    return this.captures.has(pointerId) || this.ignoredPointers.has(pointerId);
  }

  down(pointerId: number, hits: readonly OverlayPointerHit[], x: number, y: number): boolean {
    if (this.captures.has(pointerId)) return true;
    for (const hit of hits) {
      if (!hit.joystickMeshName) continue;
      const layer = this.layerFor(hit.layerId);
      const mesh = layer?.scene.getMeshByName(hit.joystickMeshName);
      const visual = mesh ? joystick2DMesh(mesh) : undefined;
      if (!layer || !visual || !this.usable(visual)) continue;
      // A second finger on an occupied stick is consumed without stealing it.
      if ([...this.captures.values()].some(capture => capture.visual === visual)) {
        this.ignoredPointers.add(pointerId);
        return true;
      }
      this.captures.set(pointerId, { visual, layer, x: 0, y: 0 });
      const observer = visual.mesh.onDisposeObservable.addOnce(() => this.release(pointerId));
      // Detach the cancellation hook on ordinary release; do not accumulate hooks per gesture.
      this.disposalHooks.set(pointerId, () => visual.mesh.onDisposeObservable.remove(observer));
      this.move(pointerId, x, y);
      return true;
    }
    return false;
  }

  private readonly disposalHooks = new Map<number, () => void>();

  move(pointerId: number, x: number, y: number): boolean {
    if (this.ignoredPointers.has(pointerId)) return true;
    const capture = this.captures.get(pointerId);
    if (!capture) return false;
    if (!this.usable(capture.visual) || this.layerFor(capture.layer.layerId) !== capture.layer) {
      this.release(pointerId);
      return true;
    }
    const { width, height } = this.size();
    const matrix = capture.visual.mesh.computeWorldMatrix(true);
    if (Math.abs(matrix.determinant()) < 1e-12) { this.release(pointerId); return true; }
    // Layer XY and component-local XY can differ through layout, parenting, rotation and scale.
    Vector3.TransformCoordinatesFromFloatsToRef(0, 0, 0, matrix, scratchWorld);
    scratchWorld.x = (x / Math.max(1, width) - 0.5) * capture.layer.layerBounds.width;
    scratchWorld.y = (0.5 - y / Math.max(1, height)) * capture.layer.layerBounds.height;
    matrix.invertToRef(scratchInverse);
    const local = Vector3.TransformCoordinatesToRef(scratchWorld, scratchInverse, scratchLocal);
    const value = joystick2DValue(local.x, local.y, capture.visual.properties);
    capture.x = value.x; capture.y = value.y;
    capture.visual.thumb.position.x = value.offsetX;
    capture.visual.thumb.position.y = value.offsetY;
    this.publish();
    return true;
  }

  release(pointerId: number): boolean {
    if (this.ignoredPointers.delete(pointerId)) return true;
    const capture = this.captures.get(pointerId);
    if (!capture) return false;
    this.captures.delete(pointerId);
    this.disposalHooks.get(pointerId)?.();
    this.disposalHooks.delete(pointerId);
    capture.visual.thumb.position.x = 0;
    capture.visual.thumb.position.y = 0;
    this.publish();
    return true;
  }

  refresh(): void {
    for (const [id, capture] of this.captures) {
      if (!this.usable(capture.visual) || this.layerFor(capture.layer.layerId) !== capture.layer) this.release(id);
    }
  }

  reset(): void {
    for (const id of this.captures.keys()) this.release(id);
    this.ignoredPointers.clear();
  }

  private usable(visual: Joystick2DMesh): boolean {
    return visual.properties.enabled && !visual.mesh.isDisposed() && visual.mesh.isEnabled() && visual.mesh.isVisible && visual.mesh.visibility > 0;
  }

  /** Strongest value per control for the pointers currently captured; rebuilt in place by each publish. */
  private values = new Map<string, number>();

  private contribute(control: string, value: number): void {
    if (!this.values.has(control) || Math.abs(value) > Math.abs(this.values.get(control)!)) this.values.set(control, value);
  }

  /** Emits only changes. `emit` must not re-enter the input: the maps below are reused. */
  private publish(): void {
    const values = this.values;
    values.clear();
    for (const { visual, x, y } of this.captures.values()) {
      this.contribute(visual.properties.horizontalControl, x);
      this.contribute(visual.properties.verticalControl, y);
    }
    // Previously emitted controls first, then newly active ones, as one pass over their union.
    for (const [control, previous] of this.emitted) {
      const value = values.get(control) ?? 0;
      if (value !== previous) this.emit(control, value);
    }
    for (const [control, value] of values) {
      if (!this.emitted.has(control) && value !== 0) this.emit(control, value);
    }
    // Swap rather than copy; the old emitted map is cleared by the next publish.
    this.values = this.emitted;
    this.emitted = values;
  }
}

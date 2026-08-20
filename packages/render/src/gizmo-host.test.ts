import { afterEach, describe, expect, it, vi } from "vitest";
import { Scene } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  clampGizmoScreenScale,
  createGizmoHost,
  GIZMO_MIN_CAMERA_DISTANCE,
} from "./gizmo-host";

const handles: Array<{
  engine: { dispose: () => void };
  scene: { dispose: () => void };
}> = [];

function createHandle() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

describe("gizmo screen-scale clamp", () => {
  it("keeps a usable scale when camera distance collapses to zero", () => {
    const ratio = 1.8;
    expect(clampGizmoScreenScale(0, ratio)).toBeCloseTo(
      ratio * GIZMO_MIN_CAMERA_DISTANCE,
    );
    expect(clampGizmoScreenScale(0.01, ratio)).toBeCloseTo(
      ratio * GIZMO_MIN_CAMERA_DISTANCE,
    );
  });

  it("preserves a healthy perspective scale and handedness", () => {
    expect(clampGizmoScreenScale(12, 1.8)).toBe(12);
    expect(clampGizmoScreenScale(-0.02, 1.8)).toBeCloseTo(
      -(1.8 * GIZMO_MIN_CAMERA_DISTANCE),
    );
  });
});

describe("gizmo Prefab RTT pointer mapping", () => {
  it("hitTests in Engine pick space when the canvas size is not the Engine size", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const host = createGizmoHost(scene);
    const pick = vi
      .spyOn(Scene.prototype, "pick")
      .mockReturnValue({ hit: false } as never);

    host.hitTest(100, 50, { width: 200, height: 100 });

    const coords = pick.mock.calls.map((call) => [call[0], call[1]]);
    expect(coords).toContainEqual([400, 200]);
    host.dispose();
  });

  it("forwards pointer down into the scene without the Engine input canvas", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(400);
    const host = createGizmoHost(scene);
    const down = vi.spyOn(scene, "simulatePointerDown");

    host.forwardPointer("down", 100, 50, { width: 200, height: 100, pointerId: 7 });

    expect(scene.pointerX).toBeCloseTo(400);
    expect(scene.pointerY).toBeCloseTo(200);
    expect(down).toHaveBeenCalled();
    const init = down.mock.calls[0]?.[1] as { pointerId?: number } | undefined;
    expect(init?.pointerId).toBe(7);
    host.dispose();
  });
});

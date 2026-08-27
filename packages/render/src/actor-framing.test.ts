import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  DEFAULT_CAMERA_RADIUS,
  MAX_CAMERA_RADIUS,
  MIN_CAMERA_RADIUS,
} from "./editor-camera";
import {
  ACTOR_FRAMING_RADIUS_PADDING,
  actorFramingRadius,
  actorFramingTarget,
} from "./actor-framing";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

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

describe("actorFramingTarget", () => {
  it("uses the visual AABB center, not only the root pivot", () => {
    const { scene } = createHandle();
    const root = MeshBuilder.CreateBox("root", { size: 2 }, scene);
    root.position.set(10, 0, 0);
    const child = MeshBuilder.CreateBox("child", { size: 2 }, scene);
    child.parent = root;
    child.position.set(8, 0, 0);
    root.computeWorldMatrix(true);
    child.computeWorldMatrix(true);

    const center = actorFramingTarget(root);
    expect(center.x).toBeGreaterThan(10);
    expect(center.x).toBeCloseTo(14, 1);
    expect(center.y).toBeCloseTo(0, 4);
    expect(center.z).toBeCloseTo(0, 4);
  });
});

describe("actorFramingRadius", () => {
  it("floors helper-sized bounds at the default viewing distance", () => {
    const { scene } = createHandle();
    const helper = MeshBuilder.CreatePlane("icon", { size: 0.5 }, scene);
    const radius = actorFramingRadius(helper, { minZ: 1 });
    expect(radius).toBe(DEFAULT_CAMERA_RADIUS);
    expect(radius).toBeGreaterThan(1 * 2);
  });

  it("pulls back past a large mesh so the eye is outside the bounds", () => {
    const { scene } = createHandle();
    const box = MeshBuilder.CreateBox("huge", { size: 40 }, scene);
    box.computeWorldMatrix(true);
    const bounds = box.getBoundingInfo().boundingBox;
    const diagonal = bounds.maximumWorld.subtract(bounds.minimumWorld).length();
    const radius = actorFramingRadius(box, { minZ: 1 });
    expect(radius).toBeGreaterThan(DEFAULT_CAMERA_RADIUS);
    expect(radius).toBeGreaterThanOrEqual(diagonal * ACTOR_FRAMING_RADIUS_PADDING);
    expect(radius).toBeLessThanOrEqual(MAX_CAMERA_RADIUS);
    expect(radius).toBeGreaterThanOrEqual(MIN_CAMERA_RADIUS);
  });

  it("stays above twice the near plane", () => {
    const { scene } = createHandle();
    const helper = MeshBuilder.CreatePlane("icon", { size: 0.5 }, scene);
    expect(actorFramingRadius(helper, { minZ: 8, defaultRadius: 0.5 })).toBe(16);
  });
});

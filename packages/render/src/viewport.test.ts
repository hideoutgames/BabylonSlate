import { describe, expect, it, afterEach } from "vitest";
import { Color3 } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  DEFAULT_LIGHT_INTENSITY,
  setHighlightColor,
  setupDefaultViewport,
} from "./viewport";
import { DEFAULT_CAMERA_RADIUS } from "./editor-camera";

describe("viewport", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("adds an active camera and a hemispheric light", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    expect(scene.activeCamera).not.toBeNull();
    expect(scene.getCameraByName("camera")).not.toBeNull();
    expect(scene.getLightByName("light")).not.toBeNull();
  });

  it("frames the origin from the default radius", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    const camera = scene.getCameraByName("camera");
    expect(camera!.position.length()).toBeCloseTo(DEFAULT_CAMERA_RADIUS, 1);
  });

  it("dims the light below full intensity", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    expect(scene.getLightByName("light")!.intensity).toBe(
      DEFAULT_LIGHT_INTENSITY,
    );
    expect(DEFAULT_LIGHT_INTENSITY).toBeLessThan(1);
  });

  it("makes the created camera the active one", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);

    expect(scene.activeCamera).toBe(scene.getCameraByName("camera"));
  });

  it("setHighlightColor writes the scene ambient colour", () => {
    const { scene } = createHandle();
    setHighlightColor(scene, new Color3(1, 0, 0));

    expect(scene.ambientColor.r).toBe(1);
    expect(scene.ambientColor.g).toBe(0);
    expect(scene.ambientColor.b).toBe(0);
  });

  it("uses the dark shell background as clearColor (oklch(0.28 0.014 250) ≈ #242a30)", () => {
    const { scene } = createHandle();

    expect(scene.clearColor.r).toBeCloseTo(36 / 255);
    expect(scene.clearColor.g).toBeCloseTo(42 / 255);
    expect(scene.clearColor.b).toBeCloseTo(48 / 255);
    expect(scene.clearColor.a).toBe(1);
  });
});

import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorCamera, DEFAULT_CAMERA_RADIUS } from "./editor-camera";
import {
  EDITOR_PLACE_MIN_DISTANCE,
  viewCenterWorldPosition,
  worldPositionFromCanvas,
} from "./editor-place";
import { projectToCanvas } from "./two-d";

const WIDTH = 800;
const HEIGHT = 600;
const CANVAS = { width: WIDTH, height: HEIGHT };

describe("editor place position", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: WIDTH,
      renderHeight: HEIGHT,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("places the 3D view center in front of the camera, short of the look-at", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.getViewMatrix();
    const position = viewCenterWorldPosition(controller.camera, "3d");
    const origin = controller.camera.position;
    const offset = new Vector3(
      position[0] - origin.x,
      position[1] - origin.y,
      position[2] - origin.z,
    );
    const distance = offset.length();
    const toTarget = controller.camera.target.subtract(origin);
    expect(distance).toBeGreaterThanOrEqual(EDITOR_PLACE_MIN_DISTANCE);
    expect(distance).toBeLessThan(controller.camera.radius);
    expect(
      Vector3.Distance(
        new Vector3(position[0], position[1], position[2]),
        controller.camera.target,
      ),
    ).toBeGreaterThan(0.5);
    expect(Vector3.Cross(offset.normalize(), toTarget.normalize()).length()).toBeLessThan(
      0.05,
    );
    expect(DEFAULT_CAMERA_RADIUS).toBe(8);
  });

  it("keeps a zoomed-out 3D spawn near the look-at instead of 4 units from the lens", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.radius = 40;
    controller.camera.getViewMatrix();
    const position = viewCenterWorldPosition(controller.camera, "3d");
    const origin = controller.camera.position;
    const distance = Vector3.Distance(
      origin,
      new Vector3(position[0], position[1], position[2]),
    );
    expect(distance).toBeGreaterThan(20);
  });

  it("clamps a zoomed-in 3D spawn so it is not in the camera lens", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.radius = 0.5;
    controller.camera.getViewMatrix();
    const position = viewCenterWorldPosition(controller.camera, "3d");
    const origin = controller.camera.position;
    const distance = Vector3.Distance(
      origin,
      new Vector3(position[0], position[1], position[2]),
    );
    expect(distance).toBeGreaterThanOrEqual(EDITOR_PLACE_MIN_DISTANCE);
  });

  it("places a 3D canvas point to the camera-right of the view center", () => {
    const controller = createEditorCamera(scene, { mode: "3d" });
    controller.camera.getViewMatrix();
    scene.updateTransformMatrix();
    const center = worldPositionFromCanvas(
      controller.camera,
      WIDTH / 2,
      HEIGHT / 2,
      CANVAS,
      "3d",
    );
    const right = worldPositionFromCanvas(
      controller.camera,
      WIDTH * 0.75,
      HEIGHT / 2,
      CANVAS,
      "3d",
    );
    const cameraRight = controller.camera.getDirection(Vector3.Right());
    const delta = new Vector3(
      right[0] - center[0],
      right[1] - center[1],
      right[2] - center[2],
    );
    expect(Vector3.Dot(delta, cameraRight)).toBeGreaterThan(0.5);
  });

  it("places the 2D view center at the camera target on the XY plane", () => {
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.updateOrthoBounds(WIDTH / HEIGHT);
    controller.pan(3, -2);
    controller.camera.getViewMatrix();
    const position = viewCenterWorldPosition(controller.camera, "2d");
    expect(position[0]).toBeCloseTo(controller.camera.target.x, 5);
    expect(position[1]).toBeCloseTo(controller.camera.target.y, 5);
    expect(position[2]).toBe(0);
  });

  it("round-trips a 2D world point through canvas pixels", () => {
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.updateOrthoBounds(WIDTH / HEIGHT);
    controller.setOrthoHalfHeight(5);
    controller.camera.getViewMatrix();
    scene.updateTransformMatrix();
    const world = new Vector3(3, -2, 0);
    const projected = projectToCanvas(scene, world, WIDTH, HEIGHT);
    if (!projected) throw new Error("projection failed");
    const back = worldPositionFromCanvas(
      controller.camera,
      projected.x,
      projected.y,
      CANVAS,
      "2d",
    );
    expect(back[0]).toBeCloseTo(world.x, 3);
    expect(back[1]).toBeCloseTo(world.y, 3);
    expect(back[2]).toBe(0);
  });
});

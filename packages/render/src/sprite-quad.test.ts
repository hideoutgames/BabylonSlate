import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spriteCollisionToBox2d } from "@babylonslate/assets";
import { createEditorCamera } from "./editor-camera";
import { createSpriteQuad } from "./sprite-quad";
import { projectToCanvas } from "./two-d";

describe("sprite quad", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 800,
      renderHeight: 600,
      textureSize: 4,
      deterministicLockstep: false,
      lockstepMaxSteps: 1,
    });
    scene = new Scene(engine);
    const camera = createEditorCamera(scene, { mode: "2d", orthoHalfHeight: 5 });
    camera.updateOrthoBounds(800 / 600);
    scene.updateTransformMatrix();
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("places a sprite at world +X to the right of the origin", () => {
    const origin = createSpriteQuad(scene, "origin", {
      name: "idle",
      u: 0,
      v: 0,
      uSize: 1,
      vSize: 1,
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      width: 100,
      height: 100,
    });
    const right = origin.clone("right")!;
    right.position = new Vector3(1, 0, 0);
    scene.updateTransformMatrix();
    expect(right.getAbsolutePosition().x).toBeGreaterThan(origin.getAbsolutePosition().x);
    const originPx = projectToCanvas(scene, origin.position, 800, 600);
    const rightPx = projectToCanvas(scene, right.position, 800, 600);
    expect(originPx && rightPx).toBeTruthy();
    expect(rightPx!.x).toBeGreaterThan(originPx!.x);
  });

  it("places the frame pivot on the mesh origin, matching the sprite collider", () => {
    const frame = {
      name: "idle", u: 0, v: 0, uSize: 1, vSize: 1, durationMs: 100,
      // Bottom-center: texture v grows downward, so the quad sits above the origin.
      pivot: { x: 0.5, y: 1 }, width: 100, height: 200,
    };
    const quad = createSpriteQuad(scene, "feet", frame);
    quad.refreshBoundingInfo();
    const box = quad.getBoundingInfo().boundingBox;
    expect([box.minimum.x, box.minimum.y, box.maximum.x, box.maximum.y]).toEqual([-0.5, 0, 0.5, 2]);
    const collider = spriteCollisionToBox2d({
      collision: { x: 0, y: 0, width: 1, height: 1 }, pivot: frame.pivot, pixelWidth: 100, pixelHeight: 200, pixelsPerUnit: 100,
    });
    expect(collider.translation.x).toBeCloseTo(box.center.x);
    expect(collider.translation.y).toBeCloseTo(box.center.y);
  });
});

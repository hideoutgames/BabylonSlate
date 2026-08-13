import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorCamera } from "./editor-camera";
import { createSpriteQuad, spriteWorldX } from "./sprite-quad";
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
    const camera = createEditorCamera(scene, { mode: "2d" });
    camera.updateOrthoBounds(800 / 600);
    camera.setOrthoHalfHeight(5);
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
    expect(spriteWorldX(right)).toBeGreaterThan(spriteWorldX(origin));
    const originPx = projectToCanvas(scene, origin.position, 800, 600);
    const rightPx = projectToCanvas(scene, right.position, 800, 600);
    expect(originPx && rightPx).toBeTruthy();
    expect(rightPx!.x).toBeGreaterThan(originPx!.x);
  });
});

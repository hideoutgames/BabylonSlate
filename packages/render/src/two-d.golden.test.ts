import { MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeGoldenText,
  readGolden,
  writeGolden,
} from "@babylonslate/test-kit";
import { createEditorCamera } from "./editor-camera";
import { meshNamesInCanvasRect, projectToCanvas, snapToGrid } from "./two-d";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const WIDTH = 800;
const HEIGHT = 600;

/**
 * Guards the mirroring trap in engineplan §13: Babylon is left-handed, so a 2D
 * camera placed on the wrong side of the XY plane flips +X on screen and every
 * 2D scene silently renders mirrored.
 */
describe("2D projection golden", () => {
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
    const controller = createEditorCamera(scene, { mode: "2d" });
    controller.updateOrthoBounds(WIDTH / HEIGHT);
    controller.setOrthoHalfHeight(5);
    scene.updateTransformMatrix();
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function project(point: Vector3) {
    const projected = projectToCanvas(scene, point, WIDTH, HEIGHT);
    if (!projected) throw new Error("projection failed");
    return {
      x: Number(projected.x.toFixed(3)),
      y: Number(projected.y.toFixed(3)),
    };
  }

  it("renders +X to the right of the origin and +Y above it", () => {
    const origin = project(Vector3.Zero());
    const right = project(new Vector3(1, 0, 0));
    const up = project(new Vector3(0, 1, 0));

    expect(right.x).toBeGreaterThan(origin.x);
    // Canvas Y grows downward, so world +Y must project to a smaller Y.
    expect(up.y).toBeLessThan(origin.y);
  });

  it("matches the committed projection golden", () => {
    const samples = {
      viewport: { width: WIDTH, height: HEIGHT },
      orthoHalfHeight: 5,
      points: {
        origin: project(Vector3.Zero()),
        right: project(new Vector3(1, 0, 0)),
        left: project(new Vector3(-1, 0, 0)),
        up: project(new Vector3(0, 1, 0)),
        down: project(new Vector3(0, -1, 0)),
      },
    };
    const serialized = `${JSON.stringify(samples, null, 2)}\n`;
    const relative = "__fixtures__/two-d-projection.golden.json";
    if (UPDATE) {
      writeGolden(FIXTURE_DIR, relative, serialized);
    }
    expect(normalizeGoldenText(serialized)).toBe(
      normalizeGoldenText(readGolden(FIXTURE_DIR, relative)),
    );
  });

  it("marquee-selects only the meshes whose origin falls inside the rect", () => {
    const left = MeshBuilder.CreatePlane("left", { size: 1 }, scene);
    left.position.set(-2, 0, 0);
    const right = MeshBuilder.CreatePlane("right", { size: 1 }, scene);
    right.position.set(2, 0, 0);
    scene.updateTransformMatrix();

    const rightPoint = projectToCanvas(scene, new Vector3(2, 0, 0), WIDTH, HEIGHT);
    expect(rightPoint).not.toBeNull();

    const hits = meshNamesInCanvasRect(
      scene,
      { x: rightPoint!.x - 20, y: rightPoint!.y - 20, width: 40, height: 40 },
      WIDTH,
      HEIGHT,
    );

    expect(hits).toContain("right");
    expect(hits).not.toContain("left");
  });
});

describe("snapToGrid", () => {
  it("rounds to the nearest step and passes through a non-positive step", () => {
    expect(snapToGrid(1.2, 1)).toBe(1);
    expect(snapToGrid(1.6, 1)).toBe(2);
    expect(snapToGrid(0.3, 0.25)).toBeCloseTo(0.25, 6);
    expect(snapToGrid(1.234, 0)).toBe(1.234);
  });
});

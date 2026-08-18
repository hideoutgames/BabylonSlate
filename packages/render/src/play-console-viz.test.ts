import { describe, expect, it } from "vitest";
import { MeshBuilder, StandardMaterial } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  applyPlayShowBounds,
  applyPlayWireframe,
  createPlayCollisionOverlay,
  createPlayConsoleViz,
} from "./play-console-viz";
import { setupDefaultViewport } from "./viewport";

describe("play console visualization", () => {
  it("sets wireframe and bounds on play meshes and skips helper overlays", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const mesh = MeshBuilder.CreateBox("actor-1", { size: 1 }, scene);
    mesh.material = new StandardMaterial("actor-1-mat", scene);
    const helper = MeshBuilder.CreateBox("helper", { size: 1 }, scene);
    helper.material = new StandardMaterial("helper-mat", scene);
    helper.metadata = { playHelperVisual: true };
    applyPlayWireframe(scene, true);
    applyPlayShowBounds(scene, true);
    expect(mesh.material?.wireframe).toBe(true);
    expect(mesh.showBoundingBox).toBe(true);
    expect(helper.material?.wireframe).toBe(false);
    expect(helper.showBoundingBox).toBe(false);
    applyPlayWireframe(scene, false);
    applyPlayShowBounds(scene, false);
    expect(mesh.material?.wireframe).toBe(false);
    expect(mesh.showBoundingBox).toBe(false);
    engine.dispose();
  });

  it("draws box, sphere, circle, and polyline collider primitives", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayCollisionOverlay(scene);
    overlay.sync([
      {
        id: "box",
        shape: "box",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 1, z: 0, w: 0 },
        halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
      },
      {
        id: "sphere",
        shape: "sphere",
        position: { x: 2, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        radius: 0.5,
      },
      {
        id: "circle",
        shape: "circle",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        radius: 1,
      },
      {
        id: "line",
        shape: "polyline",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
        ],
      },
    ]);
    const box = scene.getMeshByName("playConsoleViz:box");
    expect(box).not.toBeNull();
    expect(box?.rotationQuaternion?.y).toBeCloseTo(1);
    expect(scene.getMeshByName("playConsoleViz:sphere")).not.toBeNull();
    expect(scene.getMeshByName("playConsoleViz:circle")).not.toBeNull();
    expect(scene.getMeshByName("playConsoleViz:line")).not.toBeNull();
    overlay.sync([]);
    expect(scene.getMeshByName("playConsoleViz:box")).toBeNull();
    overlay.dispose();
    engine.dispose();
  });

  it("reuses collision overlay meshes when pose changes", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayCollisionOverlay(scene);
    const box = {
      id: "box",
      shape: "box" as const,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    };
    overlay.sync([box]);
    const first = scene.getMeshByName("playConsoleViz:box");
    overlay.sync([{ ...box, position: { x: 3, y: 0, z: 0 } }]);
    const second = scene.getMeshByName("playConsoleViz:box");
    expect(second?.uniqueId).toBe(first?.uniqueId);
    expect(second?.position.x).toBeCloseTo(3);
    overlay.dispose();
    engine.dispose();
  });

  it("applies viz commands including nav toggle", () => {
    const { engine, scene } = createTestEngine();
    const mesh = MeshBuilder.CreateBox("actor-1", { size: 1 }, scene);
    mesh.material = new StandardMaterial("actor-1-mat", scene);
    const viz = createPlayConsoleViz(scene);
    expect(
      viz.applyCommand({ type: "setWireframe", enabled: true }),
    ).toBe(true);
    expect(mesh.material?.wireframe).toBe(true);
    expect(
      viz.applyCommand({ type: "setShowBounds", enabled: true }),
    ).toBe(true);
    expect(mesh.showBoundingBox).toBe(true);
    expect(viz.applyCommand({ type: "setShowNav", enabled: false })).toBe(true);
    viz.refresh();
    viz.dispose();
    engine.dispose();
  });
});

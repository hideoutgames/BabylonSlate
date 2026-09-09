import { describe, expect, it } from "vitest";
import { Mesh, MeshBuilder, StandardMaterial, VertexBuffer } from "@babylonjs/core";
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
    expect(box?.renderingGroupId).toBe(1);
    expect(box?.rotationQuaternion?.y).toBeCloseTo(1);
    expect(scene.getMeshByName("playConsoleViz:sphere")?.renderingGroupId).toBe(1);
    expect(scene.getMeshByName("playConsoleViz:circle")).not.toBeNull();
    expect(scene.getMeshByName("playConsoleViz:line")).not.toBeNull();
    overlay.sync([]);
    expect(scene.getMeshByName("playConsoleViz:box")).toBeNull();
    overlay.dispose();
    engine.dispose();
  });

  it("draws capsule collider primitives", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayCollisionOverlay(scene);
    overlay.sync([
      {
        id: "capsule",
        shape: "capsule",
        position: { x: 0, y: 1.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        radius: 0.5,
        halfHeight: 1,
      },
    ]);
    expect(scene.getMeshByName("playConsoleViz:capsule")).not.toBeNull();
    overlay.sync([]);
    expect(scene.getMeshByName("playConsoleViz:capsule")).toBeNull();
    overlay.dispose();
    engine.dispose();
  });

  it("restores shared materials when wireframe stops, including despawned owners", () => {
    const { engine, scene } = createTestEngine();
    const material = new StandardMaterial("shared", scene);
    const first = MeshBuilder.CreateBox("first", {}, scene);
    const second = MeshBuilder.CreateBox("second", {}, scene);
    first.material = material;
    second.material = material;
    const viz = createPlayConsoleViz(scene);
    viz.applyCommand({ type: "setWireframe", enabled: true });
    expect(material.wireframe).toBe(true);
    first.dispose();
    viz.refresh();
    viz.applyCommand({ type: "setWireframe", enabled: false });
    expect(material.wireframe).toBe(false);
    material.wireframe = true;
    viz.applyCommand({ type: "setWireframe", enabled: true });
    viz.dispose();
    expect(material.wireframe).toBe(true);
    engine.dispose();
  });

  it("preserves cylinder, planar capsule, and triangle mesh collider geometry", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayCollisionOverlay(scene);
    const pose = { position: { x: 3, y: 4, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    overlay.sync([
      { id: "cylinder", shape: "cylinder", ...pose, radius: 2, height: 6 },
      { id: "capsule2d", shape: "capsule2d", ...pose, radius: 1, halfHeight: 2 },
      { id: "triangle", shape: "mesh", ...pose, points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }], indices: [0, 1, 2] },
    ]);
    const cylinder = scene.getMeshByName("playConsoleViz:cylinder");
    expect(cylinder).not.toBeNull();
    expect(cylinder!.getBoundingInfo().boundingBox.extendSize.asArray()).toEqual([2, 3, 2]);
    const capsule = scene.getMeshByName("playConsoleViz:capsule2d");
    expect(capsule).not.toBeNull();
    expect(capsule!.getBoundingInfo().boundingBox.extendSize.z).toBe(0);
    expect(capsule!.getBoundingInfo().boundingBox.extendSize.y).toBeCloseTo(3);
    expect(capsule!.position.asArray()).toEqual([3, 4, 5]);
    const triangle = scene.getMeshByName("playConsoleViz:triangle");
    expect(triangle).not.toBeNull();
    expect(triangle!.getVerticesData(VertexBuffer.PositionKind)).toEqual([0, 0, 0, 2, 0, 0, 0, 3, 0]);
    expect(triangle!.getIndices()).toEqual([0, 1, 2]);
    expect(triangle!.position.asArray()).toEqual([3, 4, 5]);
    overlay.dispose();
    expect(scene.getMeshByName("playConsoleViz:triangle")).toBeNull();
    engine.dispose();
  });

  it("draws active navigation, reuses labels, and clears independent toggles", () => {
    const { engine, scene } = createTestEngine();
    const viz = createPlayConsoleViz(scene);
    const agent = {
      actorGuid: "guard", actorName: "Guard", position: { x: 1, y: 0, z: 2 },
      velocity: { x: 1, y: 0, z: 0 }, radius: 0.5, height: 2,
      target: { x: 4, y: 0, z: 3 },
      path: [{ x: 1, y: 0, z: 2 }, { x: 2, y: 0, z: 3 }, { x: 4, y: 0, z: 3 }], state: "walking",
    };
    viz.applyCommand({ type: "setShowPathfinding", enabled: true });
    viz.applyCommand({ type: "setShowNavAgent", enabled: true });
    expect(viz.applyCommand({ type: "debugNavigation", agents: [agent], world: "3d" })).toBe(true);
    expect(scene.getMeshByName("playConsoleViz:nav:guard:path")).not.toBeNull();
    expect(scene.getMeshByName("playConsoleViz:nav:guard:markers")).not.toBeNull();
    const bounds = scene.getMeshByName("playConsoleViz:nav:guard:bounds");
    expect(bounds!.position.asArray()).toEqual([1, 1, 2]);
    const label = scene.getMeshByName("playConsoleViz:nav:guard:label");
    expect(label!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(label!.metadata.label).toContain("Guard");
    expect(label!.metadata.label).toContain("walking");
    expect(label!.isPickable).toBe(false);
    viz.applyCommand({ type: "debugNavigation", agents: [{ ...agent, position: { x: 2, y: 0, z: 2 } }], world: "3d" });
    expect(scene.getMeshByName("playConsoleViz:nav:guard:label")!.uniqueId).toBe(label!.uniqueId);
    expect(label!.position.x).toBe(2);
    viz.applyCommand({ type: "setShowPathfinding", enabled: false });
    expect(scene.getMeshByName("playConsoleViz:nav:guard:path")).not.toBeNull();
    viz.applyCommand({ type: "setShowNavAgent", enabled: false });
    expect(scene.meshes.filter((mesh) => mesh.name.startsWith("playConsoleViz:nav:"))).toHaveLength(0);
    viz.applyCommand({ type: "setShowPathfinding", enabled: true });
    viz.applyCommand({ type: "debugNavigation", agents: [agent], world: "2d" });
    expect(scene.getMeshByName("playConsoleViz:nav:guard:path")).not.toBeNull();
    expect(scene.getMeshByName("playConsoleViz:nav:guard:bounds")).toBeNull();
    viz.applyCommand({ type: "debugNavigation", agents: [], world: "2d" });
    expect(scene.getMeshByName("playConsoleViz:nav:guard:path")).toBeNull();
    viz.dispose();
    expect(scene.materials.filter((material) => material.name.startsWith("playConsoleViz:"))).toHaveLength(0);
    engine.dispose();
  });

  it("draws convex hull collider primitives", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayCollisionOverlay(scene);
    overlay.sync([
      {
        id: "hull",
        shape: "convex",
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 0, y: 1, z: 0 },
          { x: 0, y: 0, z: 1 },
        ],
      },
    ]);
    const hull = scene.getMeshByName("playConsoleViz:hull");
    expect(hull).not.toBeNull();
    expect(hull?.renderingGroupId).toBe(1);
    expect(hull?.position.x).toBeCloseTo(1);
    overlay.sync([]);
    expect(scene.getMeshByName("playConsoleViz:hull")).toBeNull();
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

  it("shownav draws NavMesh Blocker volumes even without baked bytes", () => {
    const { engine, scene } = createTestEngine();
    const viz = createPlayConsoleViz(scene, {
      navBlockers: [
        {
          id: "door",
          kind: "box",
          position: [1, 0, 2],
          rotation: [0, 0, 0, 1],
          scale: [2, 3, 4],
        },
      ],
    });
    expect(viz.applyCommand({ type: "setShowNav", enabled: true })).toBe(true);
    expect(scene.getMeshByName("navmeshDebug:blocker:door")).not.toBeNull();
    expect(viz.applyCommand({ type: "setShowNav", enabled: false })).toBe(true);
    expect(scene.getMeshByName("navmeshDebug:blocker:door")).toBeNull();
    viz.dispose();
    engine.dispose();
  });
});

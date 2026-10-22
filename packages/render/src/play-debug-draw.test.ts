import type { LinesMesh } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { CommandMessage, DebugDrawCommand } from "@haptic/bridge";
import { createTestEngine } from "./create-null-engine";
import { createPlayDebugDraw, PLAY_DEBUG_DRAW_PREFIX } from "./play-debug-draw";
import { RENDERING_GROUP } from "./sorting";
import { setupDefaultViewport } from "./viewport";

function overlayMeshes(scene: {
  meshes: Array<{ name: string; metadata?: unknown; renderingGroupId?: number }>;
}) {
  return scene.meshes.filter((mesh) => {
    const meta = mesh.metadata as { playDebugOverlay?: boolean } | null;
    return mesh.name.startsWith(PLAY_DEBUG_DRAW_PREFIX) || meta?.playDebugOverlay === true;
  });
}

function draw(
  overrides: Partial<DebugDrawCommand> & Pick<DebugDrawCommand, "kind">,
): DebugDrawCommand {
  return {
    type: "debugDraw",
    duration: 1,
    color: { x: 1, y: 1, z: 1, w: 1 },
    frameId: 1,
    ...overrides,
  };
}

describe("play debug draw", () => {
  it("draws duration-0 lines in the world group and keeps them across extra presents", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    expect(
      overlay.applyCommand(
        draw({
          kind: "line",
          duration: 0,
          start: { x: 0, y: 0, z: 0 },
          end: { x: 1, y: 0, z: 0 },
          thickness: 1,
        }),
      ),
    ).toBe(true);
    const created = overlayMeshes(scene);
    expect(created.length).toBeGreaterThan(0);
    expect(
      created.every((mesh) => {
        const meta = mesh.metadata as { playDebugOverlay?: boolean } | null;
        return (
          meta?.playDebugOverlay === true &&
          mesh.renderingGroupId === RENDERING_GROUP.world
        );
      }),
    ).toBe(true);
    scene.render();
    scene.render();
    scene.render();
    expect(overlayMeshes(scene).length).toBeGreaterThan(0);
    overlay.dispose();
    engine.dispose();
  });

  it("expires a presented duration-0 line on a later sim tick", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
      }),
    );
    overlay.noteSimTick(1);
    expect(overlayMeshes(scene).length).toBeGreaterThan(0);
    scene.render();
    overlay.noteSimTick(2);
    expect(overlayMeshes(scene)).toHaveLength(0);
    overlay.dispose();
    engine.dispose();
  });

  it("keeps a duration-0 line that presented before the matching sim tick", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
      }),
    );
    scene.render();
    overlay.noteSimTick(1);
    expect(overlayMeshes(scene).length).toBeGreaterThan(0);
    overlay.noteSimTick(2);
    expect(overlayMeshes(scene)).toHaveLength(0);
    overlay.dispose();
    engine.dispose();
  });

  it("replaces duration-0 draws on the next debugDraw without a blank present", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
      }),
    );
    overlay.noteSimTick(1);
    scene.render();
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        frameId: 2,
        start: { x: 0, y: 1, z: 0 },
        end: { x: 1, y: 1, z: 0 },
      }),
    );
    expect(overlayMeshes(scene)).toHaveLength(1);
    overlay.dispose();
    engine.dispose();
  });

  it("keeps every duration-0 draw from one runtime tick until the next tick replaces them", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
      }),
    );
    overlay.applyCommand(
      draw({ kind: "circle", duration: 0, center: { x: 1, y: 0, z: 0 }, radius: 0.1 }),
    );
    expect(overlayMeshes(scene)).toHaveLength(2);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        frameId: 2,
        start: { x: 0, y: 1, z: 0 },
        end: { x: 1, y: 1, z: 0 },
      }),
    );
    expect(overlayMeshes(scene)).toHaveLength(1);
    overlay.dispose();
    engine.dispose();
  });

  it("disposes the thick line material when the line expires", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    const materialCount = scene.materials.length;
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 0,
        thickness: 2,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
      }),
    );
    const line = scene.meshes.find((mesh) => mesh.name.startsWith(PLAY_DEBUG_DRAW_PREFIX));
    // Thick lines take the GreasedLine branch, not the CreateLines fallback.
    expect(line?.getClassName()).toBe("GreasedLineMesh");
    scene.render();
    overlay.noteSimTick(1);
    overlay.noteSimTick(2);
    expect(overlayMeshes(scene)).toHaveLength(0);
    expect(scene.materials).toHaveLength(materialCount);
    overlay.dispose();
    engine.dispose();
  });

  it("keeps a timed line across a short frame and expires after duration", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const overlay = createPlayDebugDraw(scene);
    overlay.applyCommand(
      draw({
        kind: "line",
        duration: 1,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 0, y: 1, z: 0 },
      }),
    );
    engine.getDeltaTime = () => 16;
    scene.render();
    expect(overlayMeshes(scene).length).toBeGreaterThan(0);
    engine.getDeltaTime = () => 2000;
    scene.render();
    expect(overlayMeshes(scene)).toHaveLength(0);
    overlay.dispose();
    engine.dispose();
  });

  it("draws each catalog shape as an overlay mesh", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayDebugDraw(scene);
    const commands: CommandMessage[] = [
      draw({
        kind: "point",
        position: { x: 0, y: 0, z: 0 },
        size: 0.2,
      }),
      draw({
        kind: "box",
        center: { x: 0, y: 0, z: 0 },
        extent: { x: 0.5, y: 0.5, z: 0.5 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      }),
      draw({
        kind: "sphere",
        center: { x: 1, y: 0, z: 0 },
        radius: 0.5,
        segments: 8,
      }),
      draw({
        kind: "circle",
        center: { x: 0, y: 1, z: 0 },
        radius: 0.5,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      }),
      draw({
        kind: "rectangle",
        center: { x: 0, y: 0, z: 1 },
        width: 1,
        height: 0.5,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      }),
      draw({
        kind: "square",
        center: { x: 2, y: 0, z: 0 },
        size: 1,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      }),
      draw({
        kind: "cone",
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
        length: 1,
        angle: 30,
      }),
      draw({
        kind: "cylinder",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 0, y: 1, z: 0 },
        radius: 0.25,
      }),
      draw({
        kind: "arrow",
        start: { x: 0, y: 0, z: 0 },
        end: { x: 0, y: 1, z: 0 },
        size: 0.2,
      }),
      draw({
        kind: "frustum",
        origin: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        fov: 90,
        aspect: 16 / 9,
        near: 0.1,
        far: 2,
      }),
      draw({
        kind: "coordinateSystem",
        origin: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: 1,
      }),
    ];
    for (const command of commands) {
      const before = overlayMeshes(scene).length;
      expect(overlay.applyCommand(command)).toBe(true);
      expect(overlayMeshes(scene).length).toBeGreaterThan(before);
    }
    const drawn = (kind: string) =>
      scene.meshes.filter((mesh): mesh is LinesMesh => mesh.name.startsWith(`${PLAY_DEBUG_DRAW_PREFIX}${kind}:`));
    // Thin segments of one color share a line system: all 12 box edges.
    expect(drawn("box")).toHaveLength(1);
    expect(drawn("box")[0]!.getIndices()).toHaveLength(24);
    // Each coordinate axis keeps its own color.
    expect(new Set(drawn("coordinateSystem").map((axis) => axis.color.toHexString())).size).toBe(3);
    overlay.dispose();
    expect(overlayMeshes(scene)).toHaveLength(0);
    engine.dispose();
  });

  it("bounds script-supplied sphere segments, cone angle and frustum FOV", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayDebugDraw(scene);
    const drawn = (kind: string) =>
      scene.meshes.find((mesh): mesh is LinesMesh => mesh.name.startsWith(`${PLAY_DEBUG_DRAW_PREFIX}${kind}:`))!;
    overlay.applyCommand(draw({ kind: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1, segments: 1e6 }));
    // At most 64 rings and 64 meridians of 65 points each.
    expect(drawn("sphere").getTotalVertices()).toBeLessThanOrEqual(2 * 64 * 65);
    overlay.applyCommand(draw({ kind: "cone", origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, length: 1, angle: 90 }));
    overlay.applyCommand(draw({ kind: "frustum", origin: { x: 0, y: 0, z: 0 },
      rotation: { pitch: 0, yaw: 0, roll: 0 }, fov: 180, aspect: 1, near: 0.1, far: 2 }));
    for (const kind of ["cone", "frustum"]) {
      const positions = [...(drawn(kind).getVerticesData("position") ?? [])];
      expect(positions.length).toBeGreaterThan(0);
      // An 89° cone is about 57 lengths wide; a 179° frustum about 229 far-planes.
      expect(Math.max(...positions.map(Math.abs))).toBeLessThan(500);
    }
    overlay.dispose();
    engine.dispose();
  });

  it("rewrites the previous tick's sphere in place when its layout matches, matching a fresh build", () => {
    const { engine, scene } = createTestEngine();
    const fresh = createTestEngine();
    const overlay = createPlayDebugDraw(scene);
    const freshOverlay = createPlayDebugDraw(fresh.scene);
    const sphere = (frameId: number, center: { x: number; y: number; z: number }, segments: number) =>
      draw({ kind: "sphere", duration: 0, frameId, center, radius: 2, segments });
    const sphereMeshes = (target: typeof scene) =>
      target.meshes.filter((mesh): mesh is LinesMesh => mesh.name.startsWith(`${PLAY_DEBUG_DRAW_PREFIX}sphere:`));
    const geometry = (mesh: LinesMesh) => ({ positions: [...mesh.getVerticesData("position")!], indices: [...mesh.getIndices()!] });

    overlay.applyCommand(sphere(1, { x: 0, y: 0, z: 0 }, 8));
    const [first] = sphereMeshes(scene);
    const centered = { x: 5, y: 1, z: -3 };
    overlay.applyCommand(sphere(2, centered, 8));
    freshOverlay.applyCommand(sphere(1, centered, 8));
    const [reused] = sphereMeshes(scene);
    expect(sphereMeshes(scene)).toHaveLength(1);
    expect(reused).toBe(first);
    expect(reused!.name).toMatch(new RegExp(`^${PLAY_DEBUG_DRAW_PREFIX}sphere:\\d+$`));
    expect(geometry(reused!)).toEqual(geometry(sphereMeshes(fresh.scene)[0]!));
    // 7 parallels and 8 meridians of 9 points, every one on the sphere.
    expect(reused!.getTotalVertices()).toBe((7 + 8) * 9);
    const positions = geometry(reused!).positions;
    for (let i = 0; i < positions.length; i += 3) {
      expect(Math.hypot(positions[i]! - centered.x, positions[i + 1]! - centered.y, positions[i + 2]! - centered.z)).toBeCloseTo(2, 5);
    }

    // A different segment count changes the layout: a new mesh replaces it.
    overlay.applyCommand(sphere(3, centered, 12));
    const [resized] = sphereMeshes(scene);
    expect(sphereMeshes(scene)).toHaveLength(1);
    expect(resized).not.toBe(first);
    expect(resized!.getTotalVertices()).toBe((11 + 12) * 13);
    overlay.dispose();
    freshOverlay.dispose();
    engine.dispose();
    fresh.engine.dispose();
  });
});


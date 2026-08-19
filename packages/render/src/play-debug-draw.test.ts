import { describe, expect, it } from "vitest";
import type { CommandMessage, DebugDrawCommand } from "@babylonslate/bridge";
import { createTestEngine } from "./create-null-engine";
import { createPlayDebugDraw, PLAY_DEBUG_DRAW_PREFIX } from "./play-debug-draw";
import { setupDefaultViewport } from "./viewport";

function overlayMeshes(scene: { meshes: Array<{ name: string; metadata?: unknown }> }) {
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
  it("draws a duration-0 line for one frame then expires it", () => {
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
        return meta?.playDebugOverlay === true;
      }),
    ).toBe(true);
    scene.render();
    expect(overlayMeshes(scene)).toHaveLength(0);
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
    overlay.dispose();
    expect(overlayMeshes(scene)).toHaveLength(0);
    engine.dispose();
  });

  it("ignores unrelated engine commands", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayDebugDraw(scene);
    expect(overlay.applyCommand({ type: "setWireframe", enabled: true })).toBe(
      false,
    );
    overlay.dispose();
    engine.dispose();
  });
});

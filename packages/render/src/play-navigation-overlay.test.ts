import { describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { createPlayNavigationOverlay } from "./play-navigation-overlay";

describe("createPlayNavigationOverlay", () => {
  it("labels agent speed in half-unit steps so jitter reuses the label", () => {
    const { engine, scene } = createTestEngine();
    const overlay = createPlayNavigationOverlay(scene);
    const agent = {
      actorGuid: "guard", actorName: "Guard", position: { x: 0, y: 0, z: 0 },
      velocity: { x: 3.5, y: 0, z: 0 }, radius: 0.5, height: 2, target: null, path: [], state: "moving",
    };
    const label = () => scene.getMeshByName("playConsoleViz:nav:guard:label")!;
    const update = (speed: number) => overlay.applyCommand({
      type: "debugNavigation", world: "3d", agents: [{ ...agent, velocity: { x: speed, y: 0, z: 0 } }],
    });
    try {
      overlay.applyCommand({ type: "setShowNavAgent", enabled: true });
      update(3.5);
      const first = label();
      expect(first.metadata.label).toContain("3.5 u/s");
      // Crowd steering wobbles the speed a little every update.
      update(3.3);
      update(3.7);
      expect(label().uniqueId).toBe(first.uniqueId);
      update(2.5);
      expect(label().metadata.label).toContain("2.5 u/s");
      update(0);
      expect(label().metadata.label).toContain("0.0 u/s");
      // A slow walk after standing still is not labelled as stopped.
      update(0.4);
      expect(label().metadata.label).toContain("0.5 u/s");
    } finally {
      overlay.dispose();
      engine.dispose();
    }
  });
});

import { describe, expect, it } from "vitest";
import { isPlayEngineCommandType } from "./play-engine-commands";

describe("isPlayEngineCommandType", () => {
  it("delivers physics and live navigation visualizations to both Play render hosts", () => {
    for (const type of ["setShowCollision", "debugColliders", "setShowPathfinding", "setShowNavAgent", "debugNavigation"]) {
      expect(isPlayEngineCommandType(type), type).toBe(true);
    }
  });
  it("forwards runtime material parameter writes to the renderer", () => {
    expect(isPlayEngineCommandType("setMaterialParameter")).toBe(true);
  });
  it("forwards SceneLayer compositor commands and despawn onto the Play engine", () => {
    expect(isPlayEngineCommandType("sceneLayerCreate")).toBe(true);
    expect(isPlayEngineCommandType("sceneLayerRemove")).toBe(true);
    expect(isPlayEngineCommandType("sceneLayerClear")).toBe(true);
    expect(isPlayEngineCommandType("sceneLayerPostProcess")).toBe(true);
    expect(isPlayEngineCommandType("despawn")).toBe(true);
  });

  it("does not forward host-only commands such as stats", () => {
    expect(isPlayEngineCommandType("stats")).toBe(false);
  });

  it("routes bone attachments to both Play engine hosts", () => {
    expect(isPlayEngineCommandType("attachToBone")).toBe(true);
  });
});

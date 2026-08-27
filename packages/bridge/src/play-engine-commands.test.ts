import { describe, expect, it } from "vitest";
import { isPlayEngineCommandType } from "./play-engine-commands";

describe("isPlayEngineCommandType", () => {
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
});

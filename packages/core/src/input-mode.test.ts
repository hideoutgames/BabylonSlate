import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_MODE,
  ENGINE_INPUT_MODE_ENUM_ID,
  INPUT_MODE_MEMBERS,
  inputModeAllowsGameInput,
  inputModeAllowsGuiHits,
  parseInputMode,
} from "./input-mode";

describe("engine:InputMode", () => {
  it("is a built-in enum whose default member is All", () => {
    expect(ENGINE_INPUT_MODE_ENUM_ID).toBe("engine:InputMode");
    expect(INPUT_MODE_MEMBERS).toEqual(["All", "Interface", "Game"]);
    expect(DEFAULT_INPUT_MODE).toBe("All");
  });

  it("parses known members and falls back to All", () => {
    expect(parseInputMode("Interface")).toBe("Interface");
    expect(parseInputMode("Game")).toBe("Game");
    expect(parseInputMode("All")).toBe("All");
    expect(parseInputMode("")).toBe("All");
    expect(parseInputMode(null)).toBe("All");
    expect(parseInputMode("nope")).toBe("All");
  });

  it("turns game input off in Interface and GUI hits off in Game", () => {
    expect(inputModeAllowsGameInput("All")).toBe(true);
    expect(inputModeAllowsGameInput("Game")).toBe(true);
    expect(inputModeAllowsGameInput("Interface")).toBe(false);
    expect(inputModeAllowsGuiHits("All")).toBe(true);
    expect(inputModeAllowsGuiHits("Interface")).toBe(true);
    expect(inputModeAllowsGuiHits("Game")).toBe(false);
  });
});

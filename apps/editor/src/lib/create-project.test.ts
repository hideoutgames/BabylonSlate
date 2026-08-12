import { describe, expect, it } from "vitest";
import {
  defaultCreateProjectDisplayName,
  normalizeProjectFolderName,
} from "./create-project";

describe("defaultCreateProjectDisplayName", () => {
  it("uses TestProject in test mode and MyGame otherwise", () => {
    expect(defaultCreateProjectDisplayName(true)).toBe("TestProject");
    expect(defaultCreateProjectDisplayName(false)).toBe("MyGame");
  });
});

describe("normalizeProjectFolderName", () => {
  it("appends .babproject to a display name", () => {
    expect(normalizeProjectFolderName("MyGame")).toBe("MyGame.babproject");
    expect(normalizeProjectFolderName("TestProject")).toBe(
      "TestProject.babproject",
    );
  });

  it("does not double the suffix", () => {
    expect(normalizeProjectFolderName("MyGame.babproject")).toBe(
      "MyGame.babproject",
    );
  });

  it("trims whitespace and rejects a blank name", () => {
    expect(normalizeProjectFolderName("  Hero  ")).toBe("Hero.babproject");
    expect(normalizeProjectFolderName("   ")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  createProjectNameIssue,
  normalizeProjectFolderName,
  randomProjectName,
} from "./create-project";

describe("randomProjectName", () => {
  it("draws a new combination when the suggestion is already taken", () => {
    const rolls = [0, 0, 0, 0.5, 0.5, 0.5];
    const name = randomProjectName(["amber apple arcade"], () => rolls.shift() ?? 0);
    expect(name).toBe("Maple Meadow Kingdom");
    expect(createProjectNameIssue(name, ["Amber Apple Arcade"])).toBeNull();
  });

  it("numbers the name when every draw collides", () => {
    expect(randomProjectName(["Amber Apple Arcade"], () => 0)).toBe(
      "Amber Apple Arcade 2",
    );
  });
});

describe("normalizeProjectFolderName", () => {
  it("uses the display name as the folder name", () => {
    expect(normalizeProjectFolderName("MyGame")).toBe("MyGame");
    expect(normalizeProjectFolderName("TestProject")).toBe("TestProject");
  });

  it("trims whitespace and rejects a blank name", () => {
    expect(normalizeProjectFolderName("  Hero  ")).toBe("Hero");
    expect(normalizeProjectFolderName("   ")).toBe("");
  });
});

describe("createProjectNameIssue", () => {
  it("reports Name required when the display name is blank", () => {
    expect(createProjectNameIssue("   ", [])).toBe("Name required.");
    expect(createProjectNameIssue("", ["MyGame"])).toBe("Name required.");
  });

  it("returns null for a free name", () => {
    expect(createProjectNameIssue("Hero", ["TestProject"])).toBeNull();
  });
});

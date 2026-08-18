import { describe, expect, it } from "vitest";
import {
  createProjectNameIssue,
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
  it("uses the display name as the folder name", () => {
    expect(normalizeProjectFolderName("MyGame")).toBe("MyGame");
    expect(normalizeProjectFolderName("TestProject")).toBe("TestProject");
  });

  it("strips a trailing .babproject suffix", () => {
    expect(normalizeProjectFolderName("MyGame.babproject")).toBe("MyGame");
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

  it("treats a leftover .babproject folder as the same name", () => {
    expect(
      createProjectNameIssue("TestProject", ["TestProject.babproject"]),
    ).toBe("Name already exists.");
    expect(
      createProjectNameIssue("TestProject.babproject", ["TestProject"]),
    ).toBe("Name already exists.");
  });

  it("returns null for a free name", () => {
    expect(createProjectNameIssue("Hero", ["TestProject"])).toBeNull();
  });
});

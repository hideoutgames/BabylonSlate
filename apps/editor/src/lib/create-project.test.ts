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

describe("createProjectNameIssue", () => {
  it("reports Name required when the display name is blank", () => {
    expect(createProjectNameIssue("   ", [])).toBe("Name required.");
    expect(createProjectNameIssue("", ["MyGame.babproject"])).toBe(
      "Name required.",
    );
  });

  it("reports Name already exists when the folder name is listed", () => {
    expect(
      createProjectNameIssue("TestProject", ["TestProject.babproject"]),
    ).toBe("Name already exists.");
    expect(
      createProjectNameIssue("TestProject.babproject", ["TestProject.babproject"]),
    ).toBe("Name already exists.");
  });

  it("returns null for a free name", () => {
    expect(createProjectNameIssue("Hero", ["TestProject.babproject"])).toBeNull();
  });
});

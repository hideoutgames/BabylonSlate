import { describe, expect, it } from "vitest";
import {
  displayProjectName,
  projectArchiveDownloadName,
} from "./display-project-name";

describe("displayProjectName", () => {
  it("strips a trailing .babproject suffix", () => {
    expect(displayProjectName("TestProject.babproject")).toBe("TestProject");
  });

  it("leaves names without the suffix unchanged", () => {
    expect(displayProjectName("My Game")).toBe("My Game");
  });
});

describe("projectArchiveDownloadName", () => {
  it("downloads Export Project as a .zip of the display name", () => {
    expect(projectArchiveDownloadName("My Game.babproject")).toBe("My_Game.zip");
    expect(projectArchiveDownloadName("MyGame")).toBe("MyGame.zip");
  });
});

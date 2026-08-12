import { describe, expect, it } from "vitest";
import { displayProjectName } from "./display-project-name";

describe("displayProjectName", () => {
  it("strips a trailing .babproject suffix", () => {
    expect(displayProjectName("TestProject.babproject")).toBe("TestProject");
  });

  it("leaves names without the suffix unchanged", () => {
    expect(displayProjectName("My Game")).toBe("My Game");
  });
});

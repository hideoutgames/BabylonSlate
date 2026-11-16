import { describe, expect, it, vi } from "vitest";
import type { NewRepositoryRequest, PublishOutcome } from "../services/source-control-publish";
import {
  createProjectNameIssue,
  normalizeProjectFolderName,
  publishCreatedProject,
  randomProjectName,
  type LaunchPhase,
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

describe("publishCreatedProject", () => {
  const repository: NewRepositoryRequest = {
    origin: "https://github.com",
    owner: { name: "ada", kind: "user", id: "" },
    name: "forest-run",
    private: true,
  };

  /** A Remote create's options, recording the steps it names and the publishes it starts. */
  function remote(result: PublishOutcome | Error) {
    const steps: string[] = [];
    const publish = vi.fn(async (request: NewRepositoryRequest): Promise<PublishOutcome> => {
      steps.push(`publish ${request.name}`);
      if (result instanceof Error) throw result;
      return result;
    });
    return { steps, publish, options: { repository, onPhase: (phase: LaunchPhase) => steps.push(phase) } };
  }

  it("names Initializing Source Control, then publishes the project it created", async () => {
    const { steps, publish, options } = remote({ status: "published", repositoryUrl: "https://github.com/ada/forest-run.git" });
    expect(await publishCreatedProject("created", options, publish)).toBeNull();
    expect(steps).toEqual(["source-control", "publish forest-run"]);
  });

  it("says why a project stayed Local, and nothing for an Integrated one whose push failed", async () => {
    const local = remote({ status: "local", message: "github.com could not be reached." });
    expect(await publishCreatedProject("created", local.options, local.publish)).toBe("github.com could not be reached.");
    // Publish's own problem in the status bar says it, as after Project Settings' Publish.
    const unpushed = remote({ status: "integrated", message: "github.com could not be reached." });
    expect(await publishCreatedProject("created", unpushed.options, unpushed.publish)).toBeNull();
    const failed = remote(new Error("Open a project first."));
    expect(await publishCreatedProject("created", failed.options, failed.publish)).toBe("Open a project first.");
  });

  it("publishes nothing for a Local create, a refused one, or a picked folder that already held a project", async () => {
    const local = remote({ status: "published", repositoryUrl: "" });
    expect(await publishCreatedProject("created", { onPhase: local.options.onPhase }, local.publish)).toBeNull();
    expect(await publishCreatedProject("refused", local.options, local.publish)).toBeNull();
    expect(await publishCreatedProject("opened", local.options, local.publish))
      .toBe("The folder you chose already had a project, so Haptic opened it and created no repository.");
    expect(local.publish).not.toHaveBeenCalled();
    expect(local.steps).toEqual([]);
  });
});

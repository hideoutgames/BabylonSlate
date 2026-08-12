import { describe, expect, it } from "vitest";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyProject,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
} from "./project";

describe("project schema", () => {
  it("creates an empty project with expected paths", () => {
    const project = createEmptyProject("Demo");
    expect(project.metadata.name).toBe("Demo");
    expect(project.scenes).toContain(MAIN_SCENE_FILE);
    expect(project.graphs).toContain(MAIN_GRAPH_FILE);
    expect(PROJECT_FILE).toBe("project.json");
  });

  it("creates default scene and graph structures", () => {
    expect(createDefaultScene().actors.length).toBeGreaterThan(0);
    expect(createDefaultGraph().nodes.length).toBeGreaterThan(0);
  });
});

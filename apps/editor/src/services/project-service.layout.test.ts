import { describe, expect, it, vi } from "vitest";
import { ProjectService } from "./project-service";

describe("ProjectService layout", () => {
  it("captures and restores dockview layout JSON", () => {
    const service = new ProjectService({
      pickProjectFolder: async () => ({ id: "x", name: "Test" }),
      getCurrentFolder: () => ({ id: "x", name: "Test" }),
      readText: async () => "",
      writeText: async () => {},
      exists: async () => false,
      readdir: async () => [],
      mkdir: async () => {},
    });

    const layout = { grid: { root: { type: "branch" } } };
    const api = {
      toJSON: () => layout,
      fromJSON: vi.fn(),
    };

    const captured = service.captureLayout(api as never);
    expect(captured).toEqual(layout);

    service.restoreLayout(api as never, captured);
    expect(api.fromJSON).toHaveBeenCalledWith(layout);
  });
});

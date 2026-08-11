import { describe, expect, it, vi } from "vitest";
import type { ProjectStorage } from "@babylonslate/core";
import { ProjectService } from "./project-service";

function fakeStorage(): ProjectStorage {
  return {
    pickProjectFolder: async () => ({
      id: "x",
      name: "Test",
      tier: "opfs",
    }),
    openDocumentsProject: async (name) => ({
      id: `opfs:${name}`,
      name,
      tier: "opfs",
    }),
    openKnownFolder: async (handle) => handle,
    listProjects: async () => [],
    getCurrentFolder: () => ({ id: "x", name: "Test", tier: "opfs" }),
    releaseFolder: async () => {},
    readText: async () => "",
    writeText: async () => {},
    readBinary: async () => new Uint8Array(),
    writeBinary: async () => {},
    exists: async () => false,
    readdir: async () => [],
    mkdir: async () => {},
    remove: async () => {},
    stat: async () => ({ isDir: false, size: 0, mtime: 0 }),
  };
}

describe("ProjectService layout", () => {
  it("captures and restores dockview layout JSON", () => {
    const service = new ProjectService(fakeStorage());

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

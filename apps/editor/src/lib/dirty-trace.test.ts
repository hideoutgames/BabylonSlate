import { afterEach, describe, expect, it } from "vitest";
import {
  clearDocumentDirtyTrace,
  documentDirtyTrace,
  recordDocumentDirty,
  recordSaveAllTrace,
  saveAllTrace,
} from "./dirty-trace";

afterEach(() => {
  clearDocumentDirtyTrace();
});

describe("documentDirtyTrace", () => {
  it("records the documents that were marked dirty", () => {
    recordDocumentDirty("scene", "scene:assets/main.scene.babasset");
    recordDocumentDirty("material", "material:assets/Rock.material.babasset");
    const trace = documentDirtyTrace();
    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({
      kind: "scene",
      id: "scene:assets/main.scene.babasset",
    });
    expect(trace[0]?.via).toMatch(/recordDocumentDirty|dirty-trace\.test/);
    expect(trace[1]).toMatchObject({
      kind: "material",
      id: "material:assets/Rock.material.babasset",
    });
  });

  it("records the last Save All outcome", () => {
    recordSaveAllTrace({
      ok: true,
      reason: "saved",
      dirtyBefore: 1,
      dirtyAfter: 0,
    });
    expect(saveAllTrace()).toEqual({
      ok: true,
      reason: "saved",
      dirtyBefore: 1,
      dirtyAfter: 0,
    });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clearDocumentDirtyTrace,
  documentDirtyTrace,
  recordDocumentDirty,
} from "./dirty-trace";

afterEach(() => {
  clearDocumentDirtyTrace();
});

describe("documentDirtyTrace", () => {
  it("records the documents that were marked dirty", () => {
    recordDocumentDirty("scene", "scene:assets/main.scene.babasset");
    recordDocumentDirty("material", "material:assets/Rock.material.babasset");
    expect(documentDirtyTrace()).toEqual([
      { kind: "scene", id: "scene:assets/main.scene.babasset" },
      { kind: "material", id: "material:assets/Rock.material.babasset" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  createEditorCameraPoseStore,
  resolveDocumentViewportMode,
  selectionAfterLockChange,
} from "./scene-editing-context";

describe("resolveDocumentViewportMode", () => {
  it("maps 2d and everything else to a ViewportMode", () => {
    expect(resolveDocumentViewportMode("2d")).toBe("2d");
    expect(resolveDocumentViewportMode("3d")).toBe("3d");
    expect(resolveDocumentViewportMode(null)).toBe("3d");
    expect(resolveDocumentViewportMode(undefined)).toBe("3d");
  });
});

describe("selectionAfterLockChange", () => {
  it("drops a newly locked actor from the selection", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", true)).toEqual([]);
    expect(
      selectionAfterLockChange(["a", "b", "c"], "b", true),
    ).toEqual(["a", "c"]);
  });

  it("does not change selection when unlocking", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", false)).toEqual([
      "actor-1",
    ]);
    expect(selectionAfterLockChange(["a", "b"], "c", true)).toEqual(["a", "b"]);
  });
});

describe("createEditorCameraPoseStore", () => {
  const pose = {
    pose3d: {
      target: { x: 3, y: 4, z: 5 },
      alpha: 1.2,
      beta: 0.8,
      radius: 10,
    },
    pose2d: {
      target: { x: -8, y: 2, z: 0 },
      orthoHalfHeight: 2,
      pixelZoom: 1,
    },
  };

  it("round-trips a saved session pose", () => {
    const store = createEditorCameraPoseStore();
    store.save(pose);
    expect(store.load()).toEqual(pose);
  });

  it("returns null on a fresh store", () => {
    const store = createEditorCameraPoseStore();
    expect(store.load()).toBeNull();
  });
});


describe("resolveDocumentViewportMode", () => {
  it("maps 2d and everything else to a ViewportMode", () => {
    expect(resolveDocumentViewportMode("2d")).toBe("2d");
    expect(resolveDocumentViewportMode("3d")).toBe("3d");
    expect(resolveDocumentViewportMode(null)).toBe("3d");
    expect(resolveDocumentViewportMode(undefined)).toBe("3d");
  });
});

describe("selectionAfterLockChange", () => {
  it("drops a newly locked actor from the selection", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", true)).toEqual([]);
    expect(
      selectionAfterLockChange(["a", "b", "c"], "b", true),
    ).toEqual(["a", "c"]);
  });

  it("does not change selection when unlocking", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", false)).toEqual([
      "actor-1",
    ]);
    expect(selectionAfterLockChange(["a", "b"], "c", true)).toEqual(["a", "b"]);
  });
});

import { describe, expect, it } from "vitest";
import { resolveDocumentViewportMode } from "./scene-editing-context";

describe("resolveDocumentViewportMode", () => {
  it("maps 2d and everything else to a ViewportMode", () => {
    expect(resolveDocumentViewportMode("2d")).toBe("2d");
    expect(resolveDocumentViewportMode("3d")).toBe("3d");
    expect(resolveDocumentViewportMode(null)).toBe("3d");
    expect(resolveDocumentViewportMode(undefined)).toBe("3d");
  });
});

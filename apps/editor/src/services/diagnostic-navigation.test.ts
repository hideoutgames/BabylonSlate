import { describe, expect, it } from "vitest";
import { documentIdToRevealForDiagnostic } from "./diagnostic-navigation";

describe("documentIdToRevealForDiagnostic", () => {
  it("returns the graph document id when that tab is already open", () => {
    expect(
      documentIdToRevealForDiagnostic(
        { graphId: "graph:assets/main.class.babasset" },
        ["content-browser", "graph:assets/main.class.babasset", "scene:assets/main.scene.babasset"],
      ),
    ).toBe("graph:assets/main.class.babasset");
  });

  it("returns null when the graph tab is not open", () => {
    expect(
      documentIdToRevealForDiagnostic(
        { graphId: "graph:assets/main.class.babasset" },
        ["content-browser", "scene:assets/main.scene.babasset"],
      ),
    ).toBeNull();
  });
});

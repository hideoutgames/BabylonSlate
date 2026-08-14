import { describe, expect, it } from "vitest";
import {
  documentIdToRevealForDiagnostic,
  sessionReportNavigation,
} from "./diagnostic-navigation";

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

describe("sessionReportNavigation", () => {
  it("opens the behaviour tree asset and focuses btNodeId", () => {
    const nav = sessionReportNavigation(
      { assetGuid: "tree-1", btNodeId: "wait", nodeId: "throw-node" },
      {
        getByGuid: (guid) =>
          guid === "tree-1"
            ? {
                header: { type: "BehaviourTree", name: "Patrol" },
                path: "assets/Patrol.bt.babasset",
              }
            : undefined,
      },
    );
    expect(nav.focusedNodeId).toBe("wait");
    expect(nav.document).toEqual({
      kind: "behaviour-tree",
      path: "assets/Patrol.bt.babasset",
      label: "Patrol",
    });
  });
});

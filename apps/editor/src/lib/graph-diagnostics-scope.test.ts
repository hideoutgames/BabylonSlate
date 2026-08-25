import { describe, expect, it } from "vitest";
import { shouldPublishGraphDiagnostics } from "./graph-diagnostics-scope";

describe("shouldPublishGraphDiagnostics", () => {
  it("publishes for the active Class graph", () => {
    expect(
      shouldPublishGraphDiagnostics({
        documentId: "graph:hero",
        activeDocumentId: "graph:hero",
        documentKind: "graph",
      }),
    ).toBe(true);
  });

  it("does not publish from a hidden document", () => {
    expect(
      shouldPublishGraphDiagnostics({
        documentId: "graph:other",
        activeDocumentId: "graph:hero",
        documentKind: "graph",
      }),
    ).toBe(false);
  });

  it("publishes Animation Object graphs only in Animation Object mode", () => {
    expect(
      shouldPublishGraphDiagnostics({
        documentId: "anim-graph:loco",
        activeDocumentId: "anim-graph:loco",
        documentKind: "anim-graph",
        animEditorMode: "stateMachine",
      }),
    ).toBe(false);
    expect(
      shouldPublishGraphDiagnostics({
        documentId: "anim-graph:loco",
        activeDocumentId: "anim-graph:loco",
        documentKind: "anim-graph",
        animEditorMode: "animationObject",
      }),
    ).toBe(true);
  });
});

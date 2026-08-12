import { describe, expect, it } from "vitest";
import { planPlayPreviewPrepare } from "./play-preview-prepare";

describe("planPlayPreviewPrepare", () => {
  it("launches immediately when the project is clean and scripts are current", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [],
        scriptsStale: false,
        migrationPending: false,
      }),
    ).toEqual({ action: "launch" });
  });

  it("prepares save and compile when documents are dirty and scripts are stale", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [
          { label: "main.graph.babasset" },
          { label: "main.scene.babasset" },
        ],
        scriptsStale: true,
        migrationPending: false,
      }),
    ).toEqual({
      action: "prepare",
      needsSave: true,
      needsCompile: true,
      dirtyNames: ["main.graph.babasset", "main.scene.babasset"],
    });
  });

  it("prepares compile without save when only scripts are stale", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [],
        scriptsStale: true,
        migrationPending: false,
      }),
    ).toEqual({
      action: "prepare",
      needsSave: false,
      needsCompile: true,
      dirtyNames: [],
    });
  });

  it("prepares save when documents are dirty even if scripts are current", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [{ label: "main.scene.babasset" }],
        scriptsStale: false,
        migrationPending: false,
      }),
    ).toEqual({
      action: "prepare",
      needsSave: true,
      needsCompile: false,
      dirtyNames: ["main.scene.babasset"],
    });
  });

  it("requires migration approval before saving dirty documents", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [{ label: "main.graph.babasset" }],
        scriptsStale: true,
        migrationPending: true,
      }),
    ).toEqual({ action: "migrate" });
  });

  it("skips migration when only compile is stale", () => {
    expect(
      planPlayPreviewPrepare({
        dirtyDocuments: [],
        scriptsStale: true,
        migrationPending: true,
      }),
    ).toEqual({
      action: "prepare",
      needsSave: false,
      needsCompile: true,
      dirtyNames: [],
    });
  });
});

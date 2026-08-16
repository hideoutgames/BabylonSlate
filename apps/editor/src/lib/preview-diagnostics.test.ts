import { describe, expect, it } from "vitest";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@babylonslate/debugger";
import {
  sessionEntriesFromPreviewDiagnostics,
  shouldClosePreviewOnDiagnostics,
} from "./preview-diagnostics";

describe("sessionEntriesFromPreviewDiagnostics", () => {
  it("keeps posted diagnostic codes instead of hardcoding preview", () => {
    const entries = sessionEntriesFromPreviewDiagnostics([
      {
        message: "Infinite loop detected",
        severity: "error",
        code: INFINITE_LOOP_DIAGNOSTIC_CODE,
        assetGuid: "assets/main.class.babasset",
        graphId: "event-graph",
        nodeId: "js",
        bodyLine: 1,
      },
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        code: INFINITE_LOOP_DIAGNOSTIC_CODE,
        message: "Infinite loop detected",
        nodeId: "js",
        bodyLine: 1,
      }),
    ]);
  });

  it("falls back to preview when the player omits a code", () => {
    const entries = sessionEntriesFromPreviewDiagnostics([
      { message: "boom", severity: "error" },
    ]);
    expect(entries[0]?.code).toBe("preview");
  });
});

describe("shouldClosePreviewOnDiagnostics", () => {
  it("closes Preview Build only for runtime.infinite_loop", () => {
    expect(
      shouldClosePreviewOnDiagnostics([
        { code: "runtime.uncaught" },
        { code: "preview" },
      ]),
    ).toBe(false);
    expect(
      shouldClosePreviewOnDiagnostics([
        { code: INFINITE_LOOP_DIAGNOSTIC_CODE },
      ]),
    ).toBe(true);
  });
});

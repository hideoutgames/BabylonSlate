import { describe, expect, it } from "vitest";
import {
  SessionDiagnosticAggregator,
} from "./diagnostics";
import {
  assetGuidFromSourceUrl,
  mapStackToAnchor,
  type AnchorEntry,
} from "./stack-map";
import { createInProcessRuntime } from "./driver";
import { encodeInputEvents } from "@babylonslate/input";

describe("diagnostics aggregator", () => {
  it("dedupes by code/asset/node and caps entries", () => {
    const agg = new SessionDiagnosticAggregator(2);
    agg.push({
      code: "a",
      message: "one",
      severity: "error",
      assetGuid: "g",
      nodeId: "n",
      frameId: 1,
    });
    agg.push({
      code: "a",
      message: "two",
      severity: "error",
      assetGuid: "g",
      nodeId: "n",
      frameId: 2,
    });
    agg.push({
      code: "b",
      message: "other",
      severity: "error",
      frameId: 3,
    });
    agg.push({
      code: "c",
      message: "dropped",
      severity: "error",
      frameId: 4,
    });
    expect(agg.entries()).toHaveLength(2);
    expect(agg.entries()[0]!.count).toBe(2);
    expect(agg.droppedCount()).toBe(1);
    expect(agg.isEmpty()).toBe(false);
    agg.clear();
    expect(agg.isEmpty()).toBe(true);
  });
});

describe("stack map helpers", () => {
  it("extracts asset guid and maps stacks", () => {
    expect(assetGuidFromSourceUrl("babylonslate:///abc.js")).toBe("abc");
    const tables = new Map<string, readonly AnchorEntry[]>([
      [
        "abc",
        [{ line: 1, column: 0, assetGuid: "abc", graphId: "g", nodeId: "n1" }],
      ],
    ]);
    const hit = mapStackToAnchor(
      "Error: x\n    at run (babylonslate:///abc.js:2:1)",
      tables,
    );
    expect(hit?.nodeId).toBe("n1");
  });
});

describe("runtime driver extras", () => {
  it("pauses, advances with catch-up, and reports errors", () => {
    const runtime = createInProcessRuntime({ seed: 3, maxActors: 4 });
    runtime.start();
    runtime.pause();
    runtime.tick();
    expect(runtime.getWorld().clock.tickIndex).toBe(0);
    runtime.resume();
    runtime.advance(1);
    expect(runtime.getWorld().clock.tickIndex).toBeGreaterThan(0);
    runtime.pushInputBuffer(
      encodeInputEvents([
        { kind: "key", tick: 0, code: "KeyA", phase: "down" },
      ]),
    );
    runtime.registerAnchors("fix", [
      {
        line: 1,
        column: 0,
        assetGuid: "fix",
        graphId: "g",
        nodeId: "n",
      },
    ]);
    const err = new Error("boom");
    err.stack = "Error: boom\n    at x (babylonslate:///fix.js:1:1)";
    const diag = runtime.reportError(err);
    expect(diag?.nodeId).toBe("n");
    expect(runtime.getLogRing().entries().length).toBeGreaterThan(0);
    runtime.stop();
  });
});

import { describe, expect, it } from "vitest";
import { SessionDiagnosticAggregator } from "@babylonslate/runtime";
import {
  applyPlayFpsSample,
  applyWorkerPlayStats,
  diagnosticFromCommand,
  playInputStampTick,
  previewFixtureThrowHint,
  resolvePlayFrameCap,
} from "./play-session";

describe("diagnosticFromCommand", () => {
  it("maps a worker diagnostic command into a RuntimeDiagnostic", () => {
    const diagnostic = diagnosticFromCommand({
      type: "diagnostic",
      code: "runtime.uncaught",
      message: "boom",
      assetGuid: "asset-1",
      graphId: "graph-1",
      nodeId: "node-1",
      btNodeId: "wait",
      stack: "Error: boom",
      frameId: 7,
      severity: "error",
    });
    expect(diagnostic).toEqual({
      code: "runtime.uncaught",
      message: "boom",
      severity: "error",
      assetGuid: "asset-1",
      graphId: "graph-1",
      nodeId: "node-1",
      btNodeId: "wait",
      stack: "Error: boom",
      frameId: 7,
    });
  });

  it("returns null for non-diagnostic commands", () => {
    expect(
      diagnosticFromCommand({
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBeNull();
    expect(
      diagnosticFromCommand({
        type: "log",
        severity: "error",
        category: "Script",
        message: "not a diagnostic",
        frameId: 1,
      }),
    ).toBeNull();
  });

  it("feeds a SessionDiagnosticAggregator the way the Worker Play path does", () => {
    const aggregator = new SessionDiagnosticAggregator();
    for (let i = 0; i < 3; i++) {
      const diagnostic = diagnosticFromCommand({
        type: "diagnostic",
        code: "runtime.uncaught",
        message: `boom ${i}`,
        assetGuid: "asset-1",
        nodeId: "node-1",
        frameId: i,
        severity: "error",
      });
      if (diagnostic) aggregator.push(diagnostic);
    }
    const entries = aggregator.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.count).toBe(3);
    expect(entries[0]!.nodeId).toBe("node-1");
  });
});

describe("playInputStampTick", () => {
  it("uses the in-process World tick when present", () => {
    expect(playInputStampTick(3, 99)).toBe(3);
  });

  it("uses the last worker stats tick instead of a wall-clock index", () => {
    expect(playInputStampTick(undefined, 0)).toBe(0);
    expect(playInputStampTick(undefined, 12)).toBe(12);
  });
});

describe("resolvePlayFrameCap", () => {
  it("defaults omitted or invalid caps to 60 so Play is not Infinity", () => {
    expect(resolvePlayFrameCap()).toBe(60);
    expect(resolvePlayFrameCap(0)).toBe(60);
    expect(resolvePlayFrameCap(-1)).toBe(60);
  });

  it("keeps a positive session cap", () => {
    expect(resolvePlayFrameCap(30)).toBe(30);
  });
});

describe("Play HUD stats merge", () => {
  it("keeps worker script and physics ms when the rAF pump only has fps", () => {
    const fromWorker = applyWorkerPlayStats(undefined, {
      fps: 0,
      scriptMs: 4.2,
      physicsMs: 1.8,
      frameId: 12,
    });
    expect(fromWorker).toEqual({
      fps: 0,
      scriptMs: 4.2,
      physicsMs: 1.8,
      frameId: 12,
    });
    const afterFps = applyPlayFpsSample(fromWorker, 60);
    expect(afterFps.fps).toBe(60);
    expect(afterFps.scriptMs).toBe(4.2);
    expect(afterFps.physicsMs).toBe(1.8);
    expect(afterFps.frameId).toBe(12);
  });
});

describe("previewFixtureThrowHint", () => {
  it("points at the first task node when a behaviour tree is loaded", () => {
    expect(
      previewFixtureThrowHint([
        {
          guid: "tree-1",
          document: {
            name: "Patrol",
            rootId: "root",
            blackboardGuid: null,
            nodes: [
              {
                id: "root",
                kind: "selector",
                classId: "bt.composite.selector",
                children: ["task"],
                decorators: [],
                services: [],
                properties: {},
              },
              {
                id: "task",
                kind: "task",
                classId: "bt.task.succeed",
                children: [],
                decorators: [],
                services: [],
                properties: {},
              },
            ],
          },
        },
      ]),
    ).toEqual({ assetGuid: "tree-1", btNodeId: "task" });
  });

  it("is null when Play has no behaviour tree so the graph fixture stays", () => {
    expect(previewFixtureThrowHint()).toBeNull();
    expect(previewFixtureThrowHint([])).toBeNull();
  });
});

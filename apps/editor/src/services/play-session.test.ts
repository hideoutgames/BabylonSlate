import { describe, expect, it, vi } from "vitest";
import { SessionDiagnosticAggregator } from "@babylonslate/runtime";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import {
  snapshotFloatCount,
  writeSnapshotHeader,
} from "@babylonslate/bridge";
import {
  applyPlayFpsSample,
  applyWorkerPlayStats,
  applyPlaySnapshotTick,
  diagnosticFromCommand,
  applyPlaySessionStep,
  applyPlaySessionPausedCommand,
  applyPlayHudConsoleCommand,
  shouldForwardPlayEngineCommand,
  deliverInspectSnapshot,
  inspectSnapshotFromCommand,
  isFatalPlayDiagnostic,
  playInputStampTick,
  playSessionBootControls,
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
      bodyLine: 4,
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
      bodyLine: 4,
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

  it("treats runtime.infinite_loop as session-fatal and other codes as not", () => {
    expect(isFatalPlayDiagnostic("runtime.infinite_loop")).toBe(true);
    expect(isFatalPlayDiagnostic("runtime.uncaught")).toBe(false);
    expect(isFatalPlayDiagnostic("preview")).toBe(false);
    expect(isFatalPlayDiagnostic(undefined)).toBe(false);
  });
});

describe("inspectSnapshotFromCommand", () => {
  it("returns the inspect payload from inspectSnapshot commands", () => {
    expect(
      inspectSnapshotFromCommand({
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBeNull();
    expect(
      inspectSnapshotFromCommand({
        type: "inspectSnapshot",
        snapshot: {
          tickIndex: 8,
          nodes: [
            {
              id: "hero",
              kind: "actor",
              label: "Hero",
              classId: "Actor",
              parentId: null,
              variables: { health: 4 },
            },
          ],
        },
      }),
    ).toEqual({
      tickIndex: 8,
      nodes: [
        {
          id: "hero",
          kind: "actor",
          label: "Hero",
          classId: "Actor",
          parentId: null,
          variables: { health: 4 },
        },
      ],
    });
  });

  it("delivers inspectSnapshot commands to queued waiters in order", () => {
    const received: DebugInspectSnapshot[] = [];
    const waiters: Array<(snapshot: DebugInspectSnapshot) => void> = [
      (snapshot) => received.push(snapshot),
    ];
    expect(
      deliverInspectSnapshot(waiters, {
        type: "stats",
        frameId: 1,
        tickIndex: 1,
        scriptMs: 0,
        physicsMs: 0,
      }),
    ).toBe(false);
    expect(waiters).toHaveLength(1);
    expect(
      deliverInspectSnapshot(waiters, {
        type: "inspectSnapshot",
        snapshot: { tickIndex: 9, nodes: [] },
      }),
    ).toBe(true);
    expect(received).toEqual([{ tickIndex: 9, nodes: [] }]);
    expect(waiters).toHaveLength(0);
  });
});

describe("playInputStampTick", () => {
  it("uses the in-process World tick when present", () => {
    expect(playInputStampTick(3, 99)).toBe(3);
  });

  it("uses the last worker snapshot tick instead of a wall-clock index", () => {
    expect(playInputStampTick(undefined, 0)).toBe(0);
    expect(playInputStampTick(undefined, 12)).toBe(12);
  });
});

describe("applyPlaySnapshotTick", () => {
  it("stamps worker input from snapshot tickIndex when stats are sparse", () => {
    const unpublished = new Float32Array(snapshotFloatCount(1));
    expect(applyPlaySnapshotTick(4, unpublished)).toBe(4);
    const published = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(published, {
      frameId: 9,
      tickIndex: 12,
      actorCount: 0,
      scriptMs: 1,
      physicsMs: 2,
    });
    expect(applyPlaySnapshotTick(4, published)).toBe(12);
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

describe("applyPlayHudConsoleCommand", () => {
  it("opens Stats HUD and highlights a row", () => {
    const onShowFps = vi.fn();
    const onStat = vi.fn();
    expect(
      applyPlayHudConsoleCommand(
        { type: "setShowFps", enabled: true },
        { onShowFps, onStat },
      ),
    ).toBe(true);
    expect(onShowFps).toHaveBeenCalledWith(true);
    expect(
      applyPlayHudConsoleCommand(
        { type: "setStat", name: "unit", enabled: true },
        { onShowFps, onStat },
      ),
    ).toBe(true);
    expect(onShowFps).toHaveBeenCalledWith(true);
    expect(onStat).toHaveBeenCalledWith("unit", true);
  });

  it("reports free cam so Preview can show a fly stick", () => {
    const onFreeCam = vi.fn();
    expect(
      applyPlayHudConsoleCommand(
        { type: "setFreeCam", enabled: true },
        { onFreeCam },
      ),
    ).toBe(true);
    expect(onFreeCam).toHaveBeenCalledWith(true);
    expect(
      applyPlayHudConsoleCommand(
        { type: "setFreeCam", enabled: false },
        { onFreeCam },
      ),
    ).toBe(true);
    expect(onFreeCam).toHaveBeenCalledWith(false);
  });
});

describe("shouldForwardPlayEngineCommand", () => {
  it("forwards setFreeCam onto the Play engine handle", () => {
    expect(shouldForwardPlayEngineCommand("setFreeCam")).toBe(true);
    expect(shouldForwardPlayEngineCommand("debugColliders")).toBe(true);
    expect(shouldForwardPlayEngineCommand("setRenderQuality")).toBe(true);
    expect(shouldForwardPlayEngineCommand("setShowAudioDebug")).toBe(true);
    expect(shouldForwardPlayEngineCommand("debugDraw")).toBe(true);
    expect(shouldForwardPlayEngineCommand("stats")).toBe(false);
  });
});

describe("overlayLogForCommand", () => {
  it("does not emit an [audio] overlay line for playSound", async () => {
    const { overlayLogForCommand } = await import("./play-session");
    expect(
      overlayLogForCommand({
        type: "playSound",
        assetGuid: "jump",
        volume: 0.5,
        frameId: 1,
      }),
    ).toBeNull();
  });
});

describe("applyPlaySessionPausedCommand", () => {
  it("forwards sessionPaused to overlay chrome", () => {
    const onSessionPaused = vi.fn();
    expect(
      applyPlaySessionPausedCommand(
        { type: "sessionPaused", paused: true },
        onSessionPaused,
      ),
    ).toBe(true);
    expect(onSessionPaused).toHaveBeenCalledWith(true);
    expect(
      applyPlaySessionPausedCommand(
        { type: "sessionPaused", paused: false },
        onSessionPaused,
      ),
    ).toBe(true);
    expect(onSessionPaused).toHaveBeenCalledWith(false);
  });

  it("ignores other commands", () => {
    const onSessionPaused = vi.fn();
    expect(
      applyPlaySessionPausedCommand(
        {
          type: "stats",
          frameId: 1,
          tickIndex: 1,
          scriptMs: 0,
          physicsMs: 0,
        },
        onSessionPaused,
      ),
    ).toBe(false);
    expect(onSessionPaused).not.toHaveBeenCalled();
  });
});

describe("applyPlaySessionStep", () => {
  it("steps the in-process runtime when the worker is absent", () => {
    const resume = vi.fn();
    const tick = vi.fn();
    const pause = vi.fn();
    applyPlaySessionStep({
      worker: null,
      runtime: { resume, tick, pause },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(
      tick.mock.invocationCallOrder[0]!,
    );
    expect(tick.mock.invocationCallOrder[0]).toBeLessThan(
      pause.mock.invocationCallOrder[0]!,
    );
  });

  it("posts step to the worker when present", () => {
    const postControl = vi.fn();
    const resume = vi.fn();
    const tick = vi.fn();
    const pause = vi.fn();
    applyPlaySessionStep({
      worker: { postControl },
      runtime: { resume, tick, pause },
    });
    expect(postControl).toHaveBeenCalledWith({ type: "step" });
    expect(resume).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("playSessionBootControls", () => {
  it("sends loadScripts before play", () => {
    const controls = playSessionBootControls({
      load: {
        type: "load",
        sceneAssetGuid: "play-scene",
      },
      scripts: [
        {
          assetGuid: "hero",
          classId: "Hero",
          source: "export const onBeginPlay = () => {}",
          anchors: [],
          entryPoints: [],
        },
      ],
    });
    expect(controls.map((control) => control.type)).toEqual([
      "load",
      "loadScripts",
      "play",
    ]);
  });

  it("appends setPaused after play when Pause On Play is on", () => {
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "play-scene" },
      pauseOnPlay: true,
    });
    expect(controls.map((control) => control.type)).toEqual([
      "load",
      "play",
      "setPaused",
    ]);
    expect(controls.at(-1)).toEqual({ type: "setPaused", paused: true });
  });

  it("sends loadSprites with Sprite Animation payloads before play", () => {
    const controls = playSessionBootControls({
      load: { type: "load", sceneAssetGuid: "play-scene" },
      sprites: {
        type: "loadSprites",
        sprites: [{ guid: "hero-sprite", document: { frames: [], clips: [] } }],
        spriteAnimations: [
          { guid: "walk-anim", document: { frames: [{ durationMs: 100 }] } },
        ],
      },
    });
    expect(controls.find((control) => control.type === "loadSprites")).toEqual({
      type: "loadSprites",
      sprites: [{ guid: "hero-sprite", document: { frames: [], clips: [] } }],
      spriteAnimations: [
        { guid: "walk-anim", document: { frames: [{ durationMs: 100 }] } },
      ],
    });
    expect(controls.map((control) => control.type).indexOf("play")).toBeGreaterThan(
      controls.map((control) => control.type).indexOf("loadSprites"),
    );
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

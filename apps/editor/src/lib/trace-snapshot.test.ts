import { describe, expect, it } from "vitest";
import {
  compareTraceFrames,
  compareTraceSnapshots,
  exactTraceValue,
  findTraceNode,
  flattenTraceSnapshot,
  parseTraceSnapshot,
  traceSnapshotRoots,
} from "./trace-snapshot";
import type { TraceFrame } from "@haptic/debugger";

const frame: TraceFrame = {
  tickIndex: 99,
  timeDilation: 1,
  scriptMs: 1,
  physicsMs: 2,
  logs: [],
  prints: [],
};

describe("recorded snapshot values", () => {
  it("does not interpret ordinary variables named rotation or actors as engine fields", () => {
    const actors = [
      { guid: "one", classId: "Reference" },
      { guid: "two", classId: "Reference" },
    ];
    const before = {
      actors: [
        {
          guid: "owner",
          classId: "Actor",
          variables: { rotation: [1, 2], actors },
        },
      ],
    };
    const after = {
      actors: [
        {
          guid: "owner",
          classId: "Actor",
          variables: { rotation: [1, 2], actors: [...actors].reverse() },
        },
      ],
    };
    const rows = flattenTraceSnapshot(
      traceSnapshotRoots(frame, { status: "ready", value: before }),
      new Set(),
      "rotation",
    );
    expect(rows.some((row) => row.label === "Rotation (Quaternion)")).toBe(
      false,
    );
    expect(rows.some((row) => row.label === "[0]" && row.value === 1)).toBe(
      true,
    );
    expect(compareTraceSnapshots(before, after)).toHaveLength(2);
  });
  it("treats prototype-named JSON keys as ordinary recorded fields", () => {
    const value = JSON.parse(
      '{"__proto__":7,"constructor":null,"toString":false}',
    ) as unknown;
    const rows = flattenTraceSnapshot(
      traceSnapshotRoots(frame, { status: "ready", value }),
      new Set(),
      "",
    );
    expect(rows.slice(0, 3).map((row) => typeof row.label)).toEqual([
      "string",
      "string",
      "string",
    ]);
    expect(
      compareTraceSnapshots({}, value).map((entry) => [
        entry.kind,
        entry.before,
        entry.after,
      ]),
    ).toEqual([
      ["Added", undefined, 7],
      ["Added", undefined, null],
      ["Added", undefined, false],
    ]);
  });
  it("distinguishes absent, malformed and valid null snapshots", () => {
    expect(parseTraceSnapshot(undefined)).toEqual({ status: "missing" });
    expect(parseTraceSnapshot("legacy text")).toEqual({ status: "invalid" });
    expect(parseTraceSnapshot("null")).toEqual({
      status: "ready",
      value: null,
    });
  });

  it("keeps falsy values, unknown fields, exact numbers and every numeric array entry", () => {
    const value = {
      extension: {
        absent: null,
        empty: "",
        disabled: false,
        zero: 0,
        precise: 1.23456789,
        samples: [1, 2, 3, 4, 5, 6],
      },
    };
    const roots = traceSnapshotRoots(frame, { status: "ready", value });
    const rows = flattenTraceSnapshot(roots, new Set(), "extension");
    expect(
      rows.filter((row) => row.label.startsWith("[")).map((row) => row.value),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.find((row) => row.label === "Precise")?.value).toBe(1.23456789);
    expect([null, "", false, 0, {}, []].map(exactTraceValue)).toEqual([
      "null",
      '""',
      "false",
      "0",
      "{}",
      "[]",
    ]);
  });

  it("matches actors and components by GUID and does not report array reordering as state changes", () => {
    const a = {
      guid: "a",
      classId: "Actor",
      variables: { health: 100 },
      components: [
        { guid: "c1", classId: "Component", variables: { enabled: true } },
        { guid: "c2", classId: "Component", variables: {} },
      ],
    };
    const b = { guid: "b", classId: "Actor", variables: {}, components: [] };
    const before = { tickIndex: 99, actors: [a, b] };
    const after = {
      tickIndex: 100,
      actors: [
        b,
        {
          ...a,
          variables: { health: 75 },
          components: [...a.components].reverse(),
        },
      ],
    };
    expect(compareTraceSnapshots(before, after)).toEqual([
      {
        id: "/snapshot/actors/guid:a/variables/health",
        path: "/snapshot/actors/guid:a/variables/health",
        label: "Health",
        kind: "Changed",
        before: 100,
        after: 75,
      },
    ]);
    const first = flattenTraceSnapshot(
      traceSnapshotRoots(frame, { status: "ready", value: before }),
      new Set(),
      "health",
    ).find((row) => row.label === "Health")!;
    const second = flattenTraceSnapshot(
      traceSnapshotRoots(frame, { status: "ready", value: after }),
      new Set(),
      "health",
    ).find((row) => row.label === "Health")!;
    expect(second.id).toBe(first.id);
    expect(second.path).toBe("/snapshot/actors/1/variables/health");
  });

  it("retains search ancestors and restores collapsed branches after clearing search", () => {
    const expanded = new Set<string>();
    const roots = traceSnapshotRoots(frame, {
      status: "ready",
      value: { settings: { child: { needle: 7 }, sibling: 9 } },
    });
    expect(
      flattenTraceSnapshot(roots, expanded, "needle").map((row) => row.label),
    ).toEqual(["Settings", "Child", "Needle"]);
    expect(
      flattenTraceSnapshot(roots, expanded, "").map((row) => row.label),
    ).toEqual(["Settings", "Input Events", "Behaviour Trees"]);
    expect(expanded.size).toBe(0);
  });

  it("matches recorded subsystems by GUID and labels them by class", () => {
    const inventory = { guid: "subsystem:Inventory", classId: "Inventory", variables: { gold: 3 } };
    const weather = { guid: "scene-subsystem:Weather:1", classId: "Weather", variables: {} };
    const before = { gameInstance: { guid: "runtime-gi", classId: "GameInstance", variables: {} }, subsystems: [inventory, weather] };
    const after = {
      ...before,
      subsystems: [
        { ...weather, guid: "scene-subsystem:Weather:2" },
        { ...inventory, variables: { gold: 5 } },
      ],
    };
    expect(
      compareTraceSnapshots(before, after).map(({ path, kind }) => ({ path, kind })),
    ).toEqual([
      { path: "/snapshot/subsystems/guid:subsystem:Inventory/variables/gold", kind: "Changed" },
      { path: "/snapshot/subsystems/guid:scene-subsystem:Weather:1", kind: "Removed" },
      { path: "/snapshot/subsystems/guid:scene-subsystem:Weather:2", kind: "Added" },
    ]);
    const rows = flattenTraceSnapshot(
      traceSnapshotRoots(frame, { status: "ready", value: before }),
      new Set(["/snapshot/subsystems", "/snapshot/subsystems/guid:subsystem:Inventory"]),
      "",
    );
    expect(rows.map((row) => row.label).slice(0, 6)).toEqual([
      "Game Instance",
      "Subsystems",
      "Inventory",
      "Identity",
      "Variables",
      "Weather",
    ]);
  });

  it("distinguishes missing fields from null and escapes property paths without identity collisions", () => {
    const changes = compareTraceSnapshots({ "a/b": null }, { "a~b": null });
    expect(changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "/snapshot/a~1b", kind: "Removed" },
      { path: "/snapshot/a~0b", kind: "Added" },
    ]);
  });

  it.each([
    ["NaN and an infinity, both written as null", Number.NaN, Number.POSITIVE_INFINITY, false],
    ["null and NaN", null, Number.NaN, false],
    ["0 and -0", 0, -0, false],
    ["NaN and 0", Number.NaN, 0, true],
    ["a number and its digits as text", 1, "1", true],
    ["true and the text true", true, "true", true],
    ["null and the text null", null, "null", true],
    ["undefined and null", undefined, null, true],
    ["two different numbers", 1.5, 2.5, true],
    ["a number and an object", 1, { a: 1 }, true],
  ])("compares leaves as their JSON text does: %s", (_name, before, after, changed) => {
    expect(compareTraceSnapshots({ value: before }, { value: after })).toHaveLength(changed ? 1 : 0);
  });

  describe("the state a frame records beside its snapshot", () => {
    const world = {
      actors: [{
        guid: "door-guid-1234", classId: "Door", variables: { name: "Front Door" },
        components: [{ guid: "anim-component", classId: "AnimationGraphComponent" }],
      }],
    };
    const recorded: TraceFrame = {
      ...frame,
      audio: { voices: [{ voiceId: "script:1", assetGuid: "creak", volume: 1, elapsedSeconds: 0.5, emitterActorGuid: "door-guid-1234" }], nextScriptVoice: 2 },
      sprites: [{ actorGuid: "door-guid-1234", stateId: "open", assetGuid: "door-sheet", clipName: "Opening", normalisedTime: 0.25 }],
      animGraphs: [{ componentGuid: "anim-component", graphGuid: "door-graph", state: { stateId: "open" } }],
    };

    it("lists audio voices, sprite clips and Animation Graphs, named for their actors", () => {
      const roots = traceSnapshotRoots(recorded, { status: "ready", value: world });
      const rows = flattenTraceSnapshot(roots, new Set(["/audio", "/audio/voices", "/sprites", "/animGraphs"]), "");
      const labels = rows.map((row) => row.label);
      expect(labels).toEqual(expect.arrayContaining(["Audio", "Voices", "Sprite Clips", "Animation Graphs"]));
      expect(labels).toContain("script:1 · Front Door · Door · door-gui");
      expect(labels).toContain("Front Door · Door · door-gui · Opening");
      expect(labels).toContain("Front Door · Door · door-gui · anim-com");
      // A recording made before they were kept shows none of them.
      expect(traceSnapshotRoots(frame, { status: "ready", value: world }).map((root) => root.label)).not.toContain("Audio");
    });

    it("reports their changes by voice, actor and component, beside the world's", () => {
      const next: TraceFrame = {
        ...recorded,
        audio: { voices: [
          { voiceId: "script:2", assetGuid: "slam", volume: 1, elapsedSeconds: 0 },
          { ...recorded.audio!.voices[0]!, elapsedSeconds: 0.52 },
        ], nextScriptVoice: 3 },
        sprites: [{ ...recorded.sprites![0]!, normalisedTime: 0.5 }],
      };
      const changes = compareTraceFrames({ frame: recorded, snapshot: world }, { frame: next, snapshot: world });
      expect(changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
        { path: "/audio/voices/voice:script:1/elapsedSeconds", kind: "Changed" },
        { path: "/audio/voices/voice:script:2", kind: "Added" },
        { path: "/audio/nextScriptVoice", kind: "Changed" },
        { path: "/sprites/actor:door-guid-1234/normalisedTime", kind: "Changed" },
      ]);
    });
  });

  it("finds a selected value deep in an actor, including its identity fields", () => {
    const roots = traceSnapshotRoots(frame, { status: "ready", value: {
      actors: [{ guid: "a", classId: "Door", variables: { hinge: { angle: 30 } } }, { guid: "b", classId: "Door" }],
    } });
    expect(findTraceNode(roots, "/snapshot/actors/guid:a/variables/hinge/angle")?.value).toBe(30);
    expect(findTraceNode(roots, "/snapshot/actors/guid:b/classId")?.value).toBe("Door");
    expect(findTraceNode(roots, "/snapshot/actors/guid:c")).toBeUndefined();
  });
});

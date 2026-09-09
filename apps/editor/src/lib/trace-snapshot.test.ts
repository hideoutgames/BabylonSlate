import { describe, expect, it } from "vitest";
import {
  compareTraceSnapshots,
  exactTraceValue,
  flattenTraceSnapshot,
  parseTraceSnapshot,
  traceSnapshotRoots,
} from "./trace-snapshot";
import type { TraceFrame } from "@babylonslate/debugger";

const frame: TraceFrame = {
  tickIndex: 99,
  scriptMs: 1,
  physicsMs: 2,
  logs: [],
  prints: [],
};

describe("recorded snapshot values", () => {
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

  it("distinguishes missing fields from null and escapes property paths without identity collisions", () => {
    const changes = compareTraceSnapshots({ "a/b": null }, { "a~b": null });
    expect(changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "/snapshot/a~1b", kind: "Removed" },
      { path: "/snapshot/a~0b", kind: "Added" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import {
  applyInspectSelectionToConsoleLine,
  formatDumpActors,
  formatInspectActor,
} from "./console-inspect";

const snapshot: DebugInspectSnapshot = {
  tickIndex: 3,
  nodes: [
    {
      id: "cube",
      kind: "actor",
      label: "Cube",
      classId: "Actor",
      parentId: null,
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      variables: { name: "Cube", hp: 10 },
    },
  ],
};

describe("formatDumpActors", () => {
  it("prints name, class, guid, and position", () => {
    expect(formatDumpActors(snapshot)).toBe("Cube Actor cube 1,2,3");
    expect(
      formatDumpActors({ tickIndex: 0, nodes: [] }),
    ).toBe("(no actors)");
  });
});

describe("formatInspectActor", () => {
  it("prints usage without a query or selection", () => {
    expect(formatInspectActor(snapshot, "")).toBe("inspect <name|guid>");
  });

  it("matches name or guid and lists variables", () => {
    expect(formatInspectActor(snapshot, "Cube")).toContain("position 1, 2, 3");
    expect(formatInspectActor(snapshot, "cube")).toContain('hp=10');
    expect(formatInspectActor(snapshot, "", "Cube")).toContain("Cube Actor cube");
    expect(formatInspectActor(snapshot, "missing")).toBe(
      "inspect: no actor matching 'missing'",
    );
  });
});

describe("applyInspectSelectionToConsoleLine", () => {
  it("appends overlay selection only for bare inspect", () => {
    expect(applyInspectSelectionToConsoleLine("inspect", "cube")).toBe(
      "inspect cube",
    );
    expect(applyInspectSelectionToConsoleLine("inspect Cube", "cube")).toBe(
      "inspect Cube",
    );
    expect(applyInspectSelectionToConsoleLine("inspect", null)).toBe("inspect");
  });
});

import { describe, expect, it } from "vitest";
import { collectOverridableFunctionRows } from "./overridable-functions";

describe("collectOverridableFunctionRows", () => {
  it("lists interface methods and parent overridable functions", () => {
    const rows = collectOverridableFunctionRows({
      classId: "Hero",
      parentOf: (id) => {
        if (id === "Hero") return "Pawn";
        if (id === "Pawn") return "Actor";
        return null;
      },
      graph: {
        nodes: [],
        edges: [],
        members: [
          { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "iface-1" },
          { id: "fn-1", kind: "function", name: "Jump", pins: [] },
        ],
      },
      parentGraphs: {
        Pawn: {
          nodes: [],
          edges: [],
          members: [
            {
              id: "fn-p",
              kind: "function",
              name: "Jump",
              overridable: true,
              pins: [{ name: "height", typeId: "float", direction: "in" }],
            },
            { id: "fn-q", kind: "function", name: "Dash", pins: [] },
          ],
        },
      },
      scriptInterfaces: [
        {
          guid: "iface-1",
          name: "Damageable",
          methods: [
            {
              name: "Apply Damage",
              pins: [{ name: "amount", typeId: "float", direction: "in" }],
            },
          ],
        },
      ],
    });
    const iface = rows.find((row) => row.kind === "interface");
    expect(iface).toMatchObject({
      name: "Apply Damage",
      description: "Interface · Damageable",
      overwritten: false,
    });
    expect(iface?.pins.some((pin) => pin.typeId === "exec")).toBe(true);
    const jump = rows.find((row) => row.name === "Jump");
    expect(jump).toMatchObject({
      kind: "function",
      overwritten: true,
      description: "Parent · Pawn",
    });
    expect(rows.some((row) => row.name === "Dash")).toBe(false);
  });
});

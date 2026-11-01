import { describe, expect, it } from "vitest";
import { validateGraphs } from "./validate";
import type { GraphNode, LogicGraph } from "./ir";
import { pin } from "./node-registry";
import type { ClassMemberSymbol, TypeContext } from "./type-context";
import { EXEC, delegateOf, FLOAT, objectRef } from "./types";

const ON_HIT: ClassMemberSymbol = {
  id: "on-hit", name: "On Hit", kind: "dispatcher", classId: "Pawn",
  pins: [{ name: "Damage", typeId: "float", direction: "in" }],
};
const TOOK_HIT: ClassMemberSymbol = {
  id: "took-hit", name: "Took Hit", kind: "event", classId: "Hero",
  pins: [{ name: "Amount", typeId: "float", direction: "out" }],
};

function node(id: string, typeId: string, pins: GraphNode["pins"], properties: Record<string, unknown>): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins, properties };
}

/** Begin → Bind Event to On Hit, its Event from Create Event over `createRows`. */
function bindGraph(createProperties: Record<string, unknown>): LogicGraph {
  const delegate = delegateOf([FLOAT]);
  return {
    id: "g",
    kind: "event",
    nodes: [
      node("entry", "flow.entry", [pin("execOut", "then", "out", EXEC)], {}),
      node("bind", "flow.dispatcher.bind", [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        { ...pin("target", "target", "in", objectRef("Pawn"), "data", true), selfWhenUnwired: true },
        pin("event", "Event", "in", delegate),
      ], { name: "On Hit", classId: "Pawn", implicitSelf: true, pins: ON_HIT.pins }),
      node("create", "flow.delegate.create", [
        { ...pin("object", "Object", "in", objectRef("Hero"), "data", true), selfWhenUnwired: true },
        pin("event", "Event", "out", delegate),
      ], { classId: "Hero", ...createProperties }),
    ],
    edges: [
      { id: "e1", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "bind", targetPinId: "execIn" },
      { id: "e2", sourceNodeId: "create", sourcePinId: "event", targetNodeId: "bind", targetPinId: "event" },
    ],
  };
}

function context(members: readonly ClassMemberSymbol[]): TypeContext {
  return {
    assetGuid: "hero",
    classId: "Hero",
    members,
    hierarchy: { isSubclassOf: (child, parent) => child === parent || (child === "Hero" && parent === "Pawn") },
  };
}

function codes(graph: LogicGraph, members: readonly ClassMemberSymbol[]): string[] {
  return validateGraphs([graph], context(members))
    .map((entry) => entry.code)
    .filter((code) => code.startsWith("delegate.") || code.includes("dispatcher"));
}

const EMPTY: LogicGraph = { id: "g", kind: "event", nodes: [], edges: [] };

describe("Event Dispatcher validation", () => {
  it("accepts an inherited dispatcher bound to a Create Event whose inputs match its custom event", () => {
    expect(codes(bindGraph({ memberName: "Took Hit", memberKind: "event", pins: TOOK_HIT.pins }), [ON_HIT, TOOK_HIT])).toEqual([]);
  });

  it("reports Create Event over a custom event whose outputs changed since it was chosen", () => {
    const renamed = { ...TOOK_HIT, pins: [{ name: "Damage", typeId: "float", direction: "out" as const }] };
    expect(codes(bindGraph({ memberName: "Took Hit", memberKind: "event", pins: TOOK_HIT.pins }), [ON_HIT, renamed]))
      .toEqual(["delegate.signature_mismatch"]);
  });

  it("looks up a function's inputs, not its outputs, for Create Event", () => {
    const heal: ClassMemberSymbol = {
      id: "heal", name: "Heal", kind: "function", classId: "Hero",
      pins: [
        { name: "Amount", typeId: "float", direction: "in" },
        { name: "Healed", typeId: "bool", direction: "out" },
      ],
    };
    expect(codes(bindGraph({ memberName: "Heal", memberKind: "function", pins: [heal.pins![0]] }), [ON_HIT, heal])).toEqual([]);
    expect(codes(bindGraph({ memberName: "Heal", memberKind: "event", pins: [heal.pins![0]] }), [ON_HIT, heal]))
      .toEqual(["delegate.missing_member"]);
  });

  it("reports a dispatcher a child declares again, but not the parent's alone", () => {
    const again: ClassMemberSymbol = { ...ON_HIT, id: "again", classId: "Hero" };
    const other: ClassMemberSymbol = { ...ON_HIT, id: "other", name: "On Heal", classId: "Hero" };
    expect(codes(EMPTY, [ON_HIT, again])).toEqual(["dispatcher.name_collision"]);
    expect(codes(EMPTY, [ON_HIT, other])).toEqual([]);
  });

  it("warns about a Delegate whose copied signature no longer matches its dispatcher", () => {
    const callback = (signature: ClassMemberSymbol["signature"]): ClassMemberSymbol => ({
      id: "callback", name: "Callback", kind: "variable", classId: "Hero",
      typeId: "delegate", typeClassId: "Pawn::On Hit", signature,
    });
    expect(codes(EMPTY, [ON_HIT, callback([{ typeId: "float" }])])).toEqual([]);
    const stale = validateGraphs([EMPTY], context([ON_HIT, callback([{ typeId: "int" }])]))
      .filter((entry) => entry.code === "delegate.signature_mismatch");
    expect(stale.map((entry) => [entry.severity, entry.message])).toEqual([
      ["warning", "Delegate \"Callback\" copies the inputs of On Hit (Pawn), which have changed; choose its Signature again"],
    ]);
  });
});

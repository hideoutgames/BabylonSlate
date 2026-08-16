import { describe, expect, it } from "vitest";
import { zipPinRows } from "./graph-nodes";
import type { SerializedPin } from "./graph-types";

const execIn: SerializedPin = {
  id: "execIn",
  name: "exec",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
};

const execOut: SerializedPin = {
  id: "execOut",
  name: "then",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const trueOut: SerializedPin = {
  id: "true",
  name: "true",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const falseOut: SerializedPin = {
  id: "false",
  name: "false",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const condition: SerializedPin = {
  id: "condition",
  name: "condition",
  kind: "data",
  direction: "in",
  type: { kind: "bool" },
};

const message: SerializedPin = {
  id: "message",
  name: "message",
  kind: "data",
  direction: "in",
  type: { kind: "string" },
};

const deltaSeconds: SerializedPin = {
  id: "deltaSeconds",
  name: "deltaSeconds",
  kind: "data",
  direction: "out",
  type: { kind: "float" },
};

const then0: SerializedPin = {
  id: "then0",
  name: "then_0",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const then1: SerializedPin = {
  id: "then1",
  name: "then_1",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

describe("zipPinRows", () => {
  it("pairs Branch Condition with False instead of a spare third row", () => {
    const rows = zipPinRows([execIn, condition, trueOut, falseOut]);
    expect(rows.map((row) => [row.in?.id, row.out?.id])).toEqual([
      ["execIn", "true"],
      ["condition", "false"],
    ]);
  });

  it("keeps Log Message on its own row under exec", () => {
    const rows = zipPinRows([execIn, execOut, message]);
    expect(rows.map((row) => [row.in?.id, row.out?.id])).toEqual([
      ["execIn", "execOut"],
      ["message", undefined],
    ]);
  });

  it("keeps Event Tick Delta Seconds under Then, not beside it", () => {
    const rows = zipPinRows([execOut, deltaSeconds]);
    expect(rows.map((row) => [row.in?.id, row.out?.id])).toEqual([
      [undefined, "execOut"],
      [undefined, "deltaSeconds"],
    ]);
  });

  it("leaves Sequence extra Then rows with an empty left cell", () => {
    const rows = zipPinRows([execIn, then0, then1]);
    expect(rows.map((row) => [row.in?.id, row.out?.id])).toEqual([
      ["execIn", "then0"],
      [undefined, "then1"],
    ]);
  });
});

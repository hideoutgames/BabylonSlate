import { describe, expect, it } from "vitest";
import { RandomStream, drawSeeded, type RandomSeed } from "@haptic/core";
import { Actor } from "@haptic/object-model";
import { compileGraph, ENGINE_SEED_STRUCT_ID, ENGINE_STRUCTS, type GraphEdge, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { ScriptHost } from "./script-host";
import { graphNode, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const SEED_ROW = { typeId: "struct", typeClassId: ENGINE_SEED_STRUCT_ID };
const SEED_FIELDS = ENGINE_STRUCTS.find((entry) => entry.id === ENGINE_SEED_STRUCT_ID)!.fields;
const EXEC_ROWS = [{ name: "exec", typeId: "exec", direction: "in" }, { name: "then", typeId: "exec", direction: "out" }];

type Row = { name: string; typeId: string; direction: "in" | "out"; typeClassId?: string; byReference?: boolean };

/** A Dice function: Input and Output nodes over `rows`, the body's nodes, and its edges (Input.exec → Output.then unless given). */
function fn(name: string, rows: Row[], body: GraphNode[], edges: GraphEdge[]): LogicGraph {
  const pins = [...EXEC_ROWS, ...rows];
  const execWired = edges.some((edge) => edge.sourceNodeId === "input" && edge.sourcePinId === "exec");
  return {
    id: name, kind: "function",
    nodes: [graphNode(registry, "input", "flow.function.input", { pins }), ...body, graphNode(registry, "output", "flow.function.output", { pins })],
    edges: execWired ? edges : [wire("input", "exec", "output", "then"), ...edges],
  };
}

function self(name: string, typeId: string, typeClassId?: string): Record<string, unknown> {
  return { variableName: name, typeId, ...(typeClassId ? { typeClassId } : {}), implicitSelf: true };
}

function call(functionName: string, rows: Row[]): Record<string, unknown> {
  return { functionName, classId: "Dice", implicitSelf: true, pins: [...EXEC_ROWS, ...rows] };
}

async function dice(...functions: LogicGraph[]) {
  const errors: unknown[] = [];
  const host = new ScriptHost({
    seed: 9, log: () => {}, print: () => {}, destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError: (error) => { errors.push(error); },
  });
  for (const graph of functions) {
    const compiled = compileGraph(graph, { registry, assetGuid: `Dice.${graph.id}`, exportName: graph.id });
    await host.load({ assetGuid: `Dice.${graph.id}`, classId: "Dice", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints });
  }
  const actor = new Actor({ classId: "Dice", guid: "dice" });
  const run = (name: string) => host.createContext(actor, 0, 0).invokeFunction(actor, name, {}) as Record<string, unknown>;
  return { actor, run, errors };
}

const ROLL_ROWS: Row[] = [{ name: "Value", typeId: "int", direction: "out" }];

describe("Seeded Random nodes", () => {
  it("draw from the wired Seed variable and move its Step on, so the next call continues the sequence", async () => {
    const roll = fn("Roll", ROLL_ROWS, [
      graphNode(registry, "seed", "variables.get", self("Seed", "struct", ENGINE_SEED_STRUCT_ID)),
      graphNode(registry, "roll", "random.seededInt", { "default:min": 1, "default:max": 6 }),
    ], [wire("seed", "value", "roll", "seed"), wire("roll", "out", "output", "Value")]);
    const { actor, run, errors } = await dice(roll);
    actor.setVariable("Seed", { Seed: "loot", Step: 0 });

    const first = drawSeeded({ Seed: "loot", Step: 0 }, "int", 1, 6);
    const second = drawSeeded(first.seed, "int", 1, 6);
    expect([run("Roll").Value, run("Roll").Value]).toEqual([first.value, second.value]);
    expect(actor.getVariable("Seed")).toEqual({ Seed: "loot", Step: 2 });
    // A Seed saved at Step 1 resumes with the second roll.
    actor.setVariable("Seed", { Seed: "loot", Step: 1 });
    expect(run("Roll").Value).toBe(second.value);
    expect(errors).toEqual([]);
  });

  it("advance the caller's variable through a Pass-By-Reference function input and read it back live", async () => {
    const byRefSeed: Row = { name: "Seed", ...SEED_ROW, direction: "in", byReference: true };
    const rows: Row[] = [byRefSeed, { name: "Value", typeId: "float", direction: "out" }, { name: "Step", typeId: "int", direction: "out" }];
    const rollWith = fn("RollWith", rows, [
      graphNode(registry, "roll", "random.seededFloat"),
      graphNode(registry, "steps", "random.getStepCount"),
    ], [wire("input", "Seed", "roll", "seed"), wire("roll", "out", "output", "Value"),
      wire("input", "Seed", "steps", "seed"), wire("steps", "step", "output", "Step")]);
    const caller = fn("Caller", [{ name: "Value", typeId: "float", direction: "out" }, { name: "Step", typeId: "int", direction: "out" }], [
      graphNode(registry, "seed", "variables.get", self("Seed", "struct", ENGINE_SEED_STRUCT_ID)),
      graphNode(registry, "call", "functions.call", call("RollWith", rows)),
    ], [wire("input", "exec", "call", "exec"), wire("call", "then", "output", "then"), wire("seed", "value", "call", "Seed"),
      wire("call", "Value", "output", "Value"), wire("call", "Step", "output", "Step")]);
    const { actor, run, errors } = await dice(rollWith, caller);
    actor.setVariable("Seed", { Seed: "fx", Step: 4 });

    // Step is read after the draw on the same Input, so it already sees the advanced Seed.
    expect(run("Caller")).toEqual({ Value: new RandomStream("fx", 4).nextFloat(), Step: 5 });
    expect(actor.getVariable("Seed")).toEqual({ Seed: "fx", Step: 5 });
    expect(errors).toEqual([]);
  });

  it("let Set By-Ref Var write a Pass-By-Reference input into the caller's variable", async () => {
    const count: Row = { name: "Count", typeId: "int", direction: "in", byReference: true };
    const bump = fn("Bump", [count], [
      graphNode(registry, "five", "literal.makeInt", { "default:in": 5 }),
      graphNode(registry, "set", "variables.setByRef"),
    ], [wire("input", "exec", "set", "execIn"), wire("set", "execOut", "output", "then"),
      wire("input", "Count", "set", "target"), wire("five", "out", "set", "value")]);
    const caller = fn("BumpHits", [], [
      graphNode(registry, "hits", "variables.get", self("Hits", "int")),
      graphNode(registry, "call", "functions.call", call("Bump", [count])),
    ], [wire("input", "exec", "call", "exec"), wire("call", "then", "output", "then"), wire("hits", "value", "call", "Count")]);
    const { actor, run, errors } = await dice(bump, caller);
    actor.setVariable("Hits", 1);

    run("BumpHits");
    expect(actor.getVariable("Hits")).toBe(5);
    expect(errors).toEqual([]);
  });
});

describe("Global randomization seed", () => {
  it("moves the normal Random nodes to a set Seed and reports how many values they have drawn", async () => {
    const reseed = fn("Reseed", [{ name: "Value", typeId: "float", direction: "out" }, { name: "Seed", ...SEED_ROW, direction: "out" }], [
      graphNode(registry, "make", "struct.make", { structGuid: ENGINE_SEED_STRUCT_ID, fields: SEED_FIELDS, "default:Seed": "level-3", "default:Step": 2 }),
      graphNode(registry, "set", "random.setGlobalSeed"),
      graphNode(registry, "float", "math.random"),
      graphNode(registry, "global", "random.getGlobalSeed"),
    ], [wire("input", "exec", "set", "execIn"), wire("set", "execOut", "output", "then"), wire("make", "out", "set", "seed"),
      wire("float", "out", "output", "Value"), wire("global", "seed", "output", "Seed")]);
    const { run, errors } = await dice(reseed);

    const result = run("Reseed") as { Value: number; Seed: RandomSeed };
    expect(result).toEqual({ Value: new RandomStream("level-3", 2).nextFloat(), Seed: { Seed: "level-3", Step: 3 } });
    expect(errors).toEqual([]);
  });

  it("starts from the session seed and draws Random Array Item's Item and Index from one value", async () => {
    const pick = fn("Pick", [{ name: "Item", typeId: "string", direction: "out" }, { name: "Index", typeId: "int", direction: "out" }, { name: "Seed", ...SEED_ROW, direction: "out" }], [
      graphNode(registry, "names", "array.make", { count: 3, "default:item0": "a", "default:item1": "b", "default:item2": "c" }),
      graphNode(registry, "pick", "random.arrayItem"),
      graphNode(registry, "global", "random.getGlobalSeed"),
    ], [wire("names", "out", "pick", "array"), wire("pick", "item", "output", "Item"), wire("pick", "index", "output", "Index"),
      wire("global", "seed", "output", "Seed")]);
    const { run, errors } = await dice(pick);

    const expected = new RandomStream("9").next() % 3;
    expect(run("Pick")).toEqual({ Item: ["a", "b", "c"][expected], Index: expected, Seed: { Seed: "9", Step: 1 } });
    expect(errors).toEqual([]);
  });
});

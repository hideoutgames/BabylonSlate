import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import type { LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC, actorRef, classRef, objectRef, BOXED_WILDCARD } from "./types";

function registry(): NodeRegistry {
  const nodes = new NodeRegistry();
  nodes.register({
    id: "flow.event.beginPlay",
    title: "Event Begin Play",
    category: "flow",
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {},
  });
  nodes.register({
    id: "actor.destroy",
    title: "Destroy Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.destroyActor(${ctx.input("target")});`);
    },
  });
  nodes.register({
    id: "actor.spawn",
    title: "Spawn Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("classId", "classId", "in", classRef("Actor")),
      pin("out", "out", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(`${out} = ctx.spawnActor(${ctx.input("classId")});`);
    },
  });
  nodes.register({
    id: "debug.print",
    title: "Print",
    category: "debug",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("value", "value", "in", BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.print(${ctx.input("value")});`);
    },
  });
  return nodes;
}

describe("compile pinExpr defaults", () => {
  it("ignores an illegal objectRef stored default and emits null", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: { "default:target": "Hero" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "destroy",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry: registry() });
    expect(compiled.source).toContain("ctx.destroyActor(null)");
    expect(compiled.source).not.toContain('"Hero"');
  });

  it("compiles a classRef Spawn Actor default to a class id string", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "spawn",
          typeId: "actor.spawn",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("classId", "classId", "in", classRef("Actor")),
            pin("out", "out", "out", actorRef("Actor")),
          ],
          properties: { "default:classId": "Pawn" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "spawn",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry: registry() });
    expect(compiled.source).toContain('ctx.spawnActor("Pawn")');
  });

  it("still compiles a boxedWildcard Print value stored on the node", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "print",
          typeId: "debug.print",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("value", "value", "in", BOXED_WILDCARD),
          ],
          properties: { value: "jumped" },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "print",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry: registry() });
    expect(compiled.source).toContain('ctx.print("jumped")');
    expect(compiled.source).not.toContain('tag: "null"');
  });
});

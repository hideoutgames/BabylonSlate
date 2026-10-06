import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import type { SerializedGraph } from "@babylonslate/core";
import type { TypeSchemas } from "@babylonslate/scripting";
import { compileAnimGraphScripts, GraphScriptCompileCache } from "./script-compiler";

const node = (id: string, type: string, data: Record<string, unknown> = {}): SerializedGraph["nodes"][number] => ({
  id, type, position: { x: 0, y: 0 }, data,
});

function execute(source: string, entryName: string, context: Record<string, unknown>): unknown {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const entry = new Function(`${body}\nreturn ${entryName};`)() as (ctx: unknown) => unknown;
  return entry({ checkInfiniteLoop: () => {}, ...context });
}

function animationWithData(value: SerializedGraph["nodes"][number], rule: SerializedGraph) {
  const document = createDefaultAnimGraph();
  document.animationObject = {
    nodes: [node("update", "anim.event.update"), value, node("log", "debug.log")],
    edges: [
      { id: "exec", source: "update", sourceHandle: "execOut", target: "log", targetHandle: "execIn" },
      { id: "value", source: value.id, sourceHandle: value.type === "struct.make" ? "out" : "value", target: "log", targetHandle: "message" },
    ],
  };
  document.transitions.push({
    id: "data-rule", fromStateId: "idle", toStateId: "idle", blendSeconds: 0, priority: 0, ruleGraph: rule,
  });
  return [{ guid: "data-animation", path: "assets/Data.anim.babasset", document }];
}

describe("Animation data graph compilation", () => {
  it("refreshes object and transition field hydration and cached code after Definition rename/add changes", () => {
    const original: TypeSchemas["structs"] = { stats: { name: "Stats", fields: [
      { id: "allowed", name: "Allowed", typeId: "bool", defaultValue: false },
      { id: "health", name: "Health", typeId: "float", defaultValue: 10 },
    ] } };
    const changed: TypeSchemas["structs"] = { stats: { name: "Stats", fields: [
      { id: "allowed", name: "Allowed", typeId: "bool", defaultValue: true },
      { id: "health", name: "HitPoints", typeId: "float", defaultValue: 20 },
      { id: "armor", name: "Armor", typeId: "float", defaultValue: 3 },
    ] } };
    const savedShape = { structGuid: "stats", dataDefinition: true, fields: original.stats!.fields };
    const documents = animationWithData(node("make", "struct.make", savedShape), {
      nodes: [
        node("make", "struct.make", savedShape), node("break", "struct.break", savedShape),
        node("enter", "anim.rule.enterState", { __protected: true }),
      ],
      edges: [
        { id: "shape", source: "make", sourceHandle: "out", target: "break", targetHandle: "in" },
        { id: "condition", source: "break", sourceHandle: "Allowed", target: "enter", targetHandle: "value" },
      ],
    });
    const cache = new GraphScriptCompileCache();
    for (const [schemas, expected, allowed] of [
      [original, { Allowed: false, Health: 10 }, false],
      [changed, { Allowed: true, HitPoints: 20, Armor: 3 }, true],
    ] as const) {
      const scripts = compileAnimGraphScripts(documents, { cache, structs: schemas, dataDefinitions: schemas });
      const object = scripts.find((script) => script.classId === "AnimGraph:data-animation");
      const rule = scripts.find((script) => script.classId === "AnimRule:data-animation:data-rule");
      expect(object).toBeDefined();
      expect(rule).toBeDefined();
      const logged: unknown[] = [];
      execute(object!.source, "onUpdateAnimation", {
        formatValue: JSON.stringify,
        log: (_severity: string, _category: string, value: string) => logged.push(JSON.parse(value)),
      });
      expect(logged).toEqual([expected]);
      expect(execute(rule!.source, "evaluate", {})).toMatchObject({ enter: allowed });
    }
    expect(cache.compiles).toBe(2);
    expect(documents[0]!.document.animationObject.nodes[1]!.data.fields).toEqual(original.stats!.fields);
  });

  it("refreshes inferred row Definition in object and transition code when sheet metadata changes", () => {
    const definitions: TypeSchemas["structs"] = {
      first: { name: "First", fields: [] }, second: { name: "Second", fields: [] },
    };
    const read = node("read", "data.readRow", { "default:sheet": "settings", "default:rowId": "primary" });
    const documents = animationWithData(read, {
      nodes: [read, node("enter", "anim.rule.enterState", { __protected: true })],
      edges: [{ id: "condition", source: "read", sourceHandle: "found", target: "enter", targetHandle: "value" }],
    });
    const cache = new GraphScriptCompileCache();
    for (const definitionGuid of ["first", "second"]) {
      const scripts = compileAnimGraphScripts(documents, {
        cache, structs: definitions, dataDefinitions: definitions,
        dataAssets: [{ guid: "settings", name: "Settings", type: "DataSheet", definitionGuid }],
      });
      const calls: unknown[][] = [];
      const context = {
        data: {
          readRow: (...args: unknown[]) => { calls.push(args); return {}; },
          hasRow: (...args: unknown[]) => { calls.push(args); return true; },
        },
        formatValue: JSON.stringify, log: () => {},
      };
      expect(scripts).toHaveLength(2);
      execute(scripts.find((script) => script.classId === "AnimGraph:data-animation")!.source, "onUpdateAnimation", context);
      expect(execute(scripts.find((script) => script.classId === "AnimRule:data-animation:data-rule")!.source, "evaluate", context)).toMatchObject({ enter: true });
      expect(calls).toEqual([["settings", "primary", definitionGuid], ["settings", "primary", definitionGuid]]);
    }
    expect(cache.compiles).toBe(2);
  });
});

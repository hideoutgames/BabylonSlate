import { describe, expect, it } from "vitest";
import { Parser, type Node as AcornNode } from "acorn";
import { compileGraph, type CodegenContext, type GraphNode, type GraphPin, type LogicGraph, type NodeDefinition } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { loadCompiledModule } from "@haptic/runtime";
import type { SerializedGraph } from "@haptic/core";
import { compileGraphDocuments } from "./script-compiler";

/**
 * Asset text must never become code except through an Execute JavaScript body, which Workspace Trust
 * gates. This places one hostile string, which breaks out of every context generated code could put it
 * in (string literals of both quotes, template literals and their substitutions, line and block
 * comments, every line terminator, bare numbers, array and object syntax), into every property each
 * node reads, its pin defaults, its id and the compile's names. Each compiled module must parse, and
 * the sentinel must appear only inside string literals, never as code.
 */
const SENTINEL = "__pwned";
const HOSTILE = [
  `x"); ${SENTINEL}(); ("`,
  `x'); ${SENTINEL}(); ('`,
  `\`; ${SENTINEL}(); \`\${${SENTINEL}()}`,
  `*/ ${SENTINEL}(); /*`,
  `\n${SENTINEL}();//`,
  `\r${SENTINEL}();//`,
  `\u2028${SENTINEL}();//`,
  `\u2029${SENTINEL}();//`,
  `]; ${SENTINEL}(); [`,
  `}); ${SENTINEL}(); ({`,
  `1; ${SENTINEL}()`,
].join("");

/** Shapes a property may hold: text, a list, pin-like rows and a keyed map. */
const SHAPES: unknown[] = [
  HOSTILE,
  [HOSTILE],
  [{ id: HOSTILE, name: HOSTILE, key: HOSTILE, value: HOSTILE, label: HOSTILE, path: HOSTILE, type: { kind: "float" }, typeId: "float" }],
  { [HOSTILE]: HOSTILE },
];

/** The execution body of the Execute JavaScript node is code by design; its pin names are not. */
const CODE_BY_DESIGN = new Set(["debug.executeJavaScript:body"]);

const registry = createDefaultNodeRegistry();

/** Property names a node reads while its pins and code are generated, found by recording reads. */
function readKeys(def: NodeDefinition, properties: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const recorded = new Proxy(properties, {
    get(target, key, receiver) {
      if (typeof key === "string") keys.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  let pins: GraphPin[] = [];
  try { pins = def.pins(recorded); } catch { /* A shape it rejects reads what it read. */ }
  const node: GraphNode = { id: "n", typeId: def.id, position: { x: 0, y: 0 }, pins, properties: recorded };
  const graph: LogicGraph = { id: "g", kind: "event", nodes: [node], edges: [] };
  const ctx: CodegenContext = {
    graph, node, indent: "  ",
    input: () => "__in", reference: () => "__ref", output: () => "__out", isWired: () => false,
    emit: () => {}, hoist: () => {}, requestAsync: () => {}, continueIf: () => {}, branch: () => {}, runOutputIf: () => {},
    inputType: () => undefined, shared: (expression) => expression, isLatentFunction: () => false,
  };
  try { def.codegen(ctx); } catch { /* Same. */ }
  return keys;
}

const execIn = (pins: GraphPin[]) => pins.find((pin) => pin.kind === "exec" && pin.direction === "in");
const execOut = (pins: GraphPin[]) => pins.find((pin) => pin.kind === "exec" && pin.direction === "out");

/** A graph that compiles `node`: run from Begin Play, read by a Print, or as its own entry. */
function graphAround(node: GraphNode): LogicGraph {
  const begin: GraphNode = { id: "begin", typeId: "flow.event.beginPlay", position: { x: 0, y: 0 }, pins: registry.get("flow.event.beginPlay")!.pins({}), properties: {} };
  const print: GraphNode = { id: "print", typeId: "debug.print", position: { x: 0, y: 0 }, pins: registry.get("debug.print")!.pins({}), properties: {} };
  const edges: LogicGraph["edges"] = [];
  const into = execIn(node.pins);
  if (into) {
    edges.push({ id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: node.id, targetPinId: into.id });
  } else {
    const out = execOut(node.pins);
    if (out) edges.push({ id: "e1", sourceNodeId: node.id, sourcePinId: out.id, targetNodeId: "print", targetPinId: "execIn" });
    else edges.push({ id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "print", targetPinId: "execIn" });
  }
  const data = node.pins.find((pin) => pin.kind === "data" && pin.direction === "out");
  if (data) edges.push({ id: "e2", sourceNodeId: node.id, sourcePinId: data.id, targetNodeId: "print", targetPinId: "value" });
  return { id: HOSTILE, kind: "event", nodes: [begin, print, node], edges };
}

/** Where the sentinel runs as code, or why the module does not parse; null when the module is safe. */
function injection(source: string): string | null {
  let ast: AcornNode;
  try {
    ast = Parser.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return `does not parse: ${error instanceof Error ? error.message : String(error)}`;
  }
  const stack: unknown[] = [ast];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { stack.push(...value); continue; }
    const node = value as Record<string, unknown>;
    if ((node.type === "Identifier" || node.type === "PrivateIdentifier") && node.name === SENTINEL) return `runs the sentinel at ${String(node.start)}`;
    for (const [key, child] of Object.entries(node)) if (key !== "loc") stack.push(child);
  }
  return null;
}

function compileSource(graph: LogicGraph, names = { assetGuid: "a", className: "C" }): string | null {
  try {
    return compileGraph(graph, { assetGuid: names.assetGuid, className: names.className, registry, instrumentInfiniteLoops: true, instrumentExecutionTrace: true }).source;
  } catch {
    // A refused graph ships nothing.
    return null;
  }
}

describe("generated code never runs asset text", () => {
  it("keeps hostile text in every node property, pin default and node id out of the code", () => {
    const findings: string[] = [];
    /** Every type must compile at least once, or the check would pass by refusing everything. */
    const neverCompiled = new Set(registry.list().map((def) => def.id));
    let compiledCases = 0;
    for (const def of registry.list()) {
      if (def.id === "flow.event.beginPlay" || def.id === "debug.print") continue;
      const keys = readKeys(def, {});
      // Reads that depend on other values: read again with every key already hostile.
      for (const key of readKeys(def, Object.fromEntries([...keys].map((key) => [key, HOSTILE])))) keys.add(key);
      const cases: Array<{ label: string; properties: Record<string, unknown>; id?: string }> = [{ label: "node id", properties: {}, id: HOSTILE }];
      for (const key of keys) {
        if (CODE_BY_DESIGN.has(`${def.id}:${key}`)) continue;
        SHAPES.forEach((shape, index) => cases.push({ label: `${key} (shape ${index})`, properties: { [key]: shape } }));
      }
      for (const { label, properties, id } of cases) {
        let pins: GraphPin[];
        try { pins = def.pins(properties); } catch { continue; }
        const withDefaults = { ...properties };
        for (const pin of pins) if (pin.direction === "in" && pin.kind === "data") withDefaults[`default:${pin.id}`] ??= HOSTILE;
        for (const props of [properties, withDefaults]) {
          const source = compileSource(graphAround({ id: id ?? "n", typeId: def.id, position: { x: 0, y: 0 }, pins, properties: props }));
          if (source !== null) {
            neverCompiled.delete(def.id);
            compiledCases += 1;
          }
          const found = source === null ? null : injection(source);
          if (found) findings.push(`${def.id} ${label}${props === withDefaults ? " + pin defaults" : ""}: ${found}`);
        }
      }
    }
    expect(findings).toEqual([]);
    neverCompiled.delete("flow.event.beginPlay");
    neverCompiled.delete("debug.print");
    expect([...neverCompiled]).toEqual([]);
    expect(compiledCases).toBeGreaterThan(2 * registry.list().length);
  });

  it("keeps hostile asset and class names out of the code", () => {
    const begin = registry.get("flow.event.beginPlay")!;
    // A node type the catalog does not know (a crafted or removed type) in the chain as well.
    const unknown: GraphNode = { id: HOSTILE, typeId: HOSTILE, position: { x: 0, y: 0 }, properties: {}, pins: [
      { id: "execIn", name: "In", kind: "exec", direction: "in", type: { kind: "exec" } },
    ] };
    const graph: LogicGraph = { id: HOSTILE, kind: "event", nodes: [{ id: "begin", typeId: begin.id, position: { x: 0, y: 0 }, pins: begin.pins({}), properties: {} }, unknown],
      edges: [{ id: "e", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: HOSTILE, targetPinId: "execIn" }] };
    const source = compileSource(graph, { assetGuid: HOSTILE, className: HOSTILE });
    expect(source).not.toBeNull();
    expect(injection(source!)).toBeNull();
  });

  it("detects a raw interpolation, so the check above can fail", () => {
    expect(injection(`const a = "${HOSTILE}";`)).not.toBeNull();
    expect(injection(`const a = ${JSON.stringify(HOSTILE)};`)).toBeNull();
  });
});

describe("asset payloads that ran code without Execute JavaScript", () => {
  type Pwned = { __pwned?: boolean };
  const payload = "x */ globalThis.__pwned = true; /*";

  it("a node id inside a generated comment", async () => {
    // Event Begin Play runs a Break that is in no loop: its comment named the node id.
    const content: SerializedGraph = {
      nodes: [
        { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} },
        { id: payload, type: "flow.break", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: "e", source: "begin", target: payload, sourceHandle: "execOut", targetHandle: "execIn" }],
    };
    const [script] = compileGraphDocuments([{ path: "assets/Hero.class.hasset", content, parentClassId: "Actor" }], { throwOnError: true });
    expect(injection(script!.source)).toBeNull();
    const exports = await loadCompiledModule(script!, "Hero");
    delete (globalThis as Pwned).__pwned;
    try {
      (exports.onBeginPlay as (ctx: unknown) => unknown)(new Proxy({}, { get: () => () => undefined }));
    } catch { /* Only the sentinel matters. */ }
    expect((globalThis as Pwned).__pwned).toBeUndefined();
  });

  it("an asset guid in the module's source label", async () => {
    // A crafted header guid names the module at load, in the loader's last line.
    delete (globalThis as Pwned).__pwned;
    const module = { source: "export function run(ctx) {}\n", entryPoints: [{ name: "run" }] };
    await loadCompiledModule(module, "guid\nglobalThis.__pwned = true;\n//");
    await loadCompiledModule(module, "guid\u2028globalThis.__pwned = true;\u2028//");
    expect((globalThis as Pwned).__pwned).toBeUndefined();
  });
});

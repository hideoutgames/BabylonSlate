import { describe, expect, it } from "vitest";
import { diffGraphDocuments, type GraphDiffSection } from "@haptic/assets/asset-diff";
import type { GraphDocument } from "@haptic/graph-ui";
import { createStateGraph } from "@haptic/anim-graph";
import { animStateMachineDiffGraph } from "../lib/anim-graph-diff-graph";
import { behaviourTreeDiffGraph } from "../lib/behaviour-tree-diff-graph";
import { materialDiffGraph } from "../lib/material-diff-graph";
import { particleDiffGraph } from "../lib/particle-diff-graph";
import { scriptDiffGraph } from "../lib/script-diff-graph";
import { DIFF_CHANGES, DIFF_STATUS, diffCanvasDocument, graphDiffSection, type DiffMode } from "./diff-graph-canvas-model";

// Each family's two stored versions, through the asset diff and the family's adapter, to the graph the Diff
// window's canvas draws in each mode: which nodes it holds, how each is tagged, and the base's wires it adds.

type Adapter = (stored: unknown) => GraphDocument;

function canvas(section: GraphDiffSection, toGraph: Adapter, mode: DiffMode): GraphDocument {
  return diffCanvasDocument(section, mode, section.base == null ? null : toGraph(section.base), section.compare == null ? null : toGraph(section.compare));
}

/** Each node's id and tag (null when it is drawn plain), in the order drawn. */
function tags(graph: GraphDocument): Array<[string, unknown]> {
  return graph.nodes.map((node) => [node.id, node.data[DIFF_STATUS] ?? null]);
}

function changesOn(graph: GraphDocument, id: string): unknown {
  return graph.nodes.find((node) => node.id === id)?.data[DIFF_CHANGES];
}

describe("diff canvas model", () => {
  it("draws a Class's graph as stored: changed and added tagged, the base's removed node and wire overlaid", () => {
    const pin = { id: "speed", name: "Max Walk Speed", kind: "data", direction: "in", type: { kind: "float" } };
    const node = (id: string, title: string, data: Record<string, unknown> = {}) => ({ id, type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "call.custom", title, __pins: [pin], ...data } });
    const graph = (speed: number, last: string) => ({
      nodes: [node("begin", "Event Begin Play"), node("set", "Set Max Walk Speed", { "default:speed": speed }), node(last, last)],
      edges: [{ id: "e1", source: "begin", target: "set", sourceHandle: "then", targetHandle: "exec" }, { id: `e-${last}`, source: "set", target: last, sourceHandle: "then", targetHandle: "exec" }],
      members: [],
    });
    const section = diffGraphDocuments(graph(600, "print"), graph(750, "sound"), "Class").sections[0]!;
    expect(section.canvas).toBe("script");

    const overlay = canvas(section, scriptDiffGraph, "overlay");
    expect(tags(overlay)).toEqual([["begin", null], ["set", "changed"], ["sound", "added"], ["print", "removed"]]);
    expect(overlay.edges.map((edge) => edge.id)).toEqual(["e1", "e-sound", "e-print"]);
    expect(changesOn(overlay, "set")).toEqual([{ id: "speed", name: "Max Walk Speed", base: "600", compare: "750" }]);
    // Each version alone: the base never shows what was added, the compare version never what was removed.
    expect(tags(canvas(section, scriptDiffGraph, "base"))).toEqual([["begin", null], ["set", "changed"], ["print", "removed"]]);
    expect(tags(canvas(section, scriptDiffGraph, "compare"))).toEqual([["begin", null], ["set", "changed"], ["sound", "added"]]);
  });

  it("hydrates script nodes stored without pins, as a new state's graph is, so its wires attach; stored pins stay as saved", () => {
    const graph = createStateGraph("3d");
    const moved = { ...graph, nodes: graph.nodes.map((node) => (node.id === "output" ? { ...node, position: { x: 600, y: 80 } } : node)) };
    const animation = (stateGraph: unknown) => ({
      name: "Locomotion",
      variables: [],
      stateMachine: { entryStateId: "idle", states: [{ id: "idle", name: "Idle", position: { x: 0, y: 0 }, stateGraph }], transitions: [], aliases: [] },
    });
    const section = diffGraphDocuments(animation(graph), animation(moved), "AnimationGraph3D").sections.find((entry) => entry.id === "state:idle")!;
    expect(section.canvas).toBe("script");
    const compare = canvas(section, scriptDiffGraph, "compare");
    expect(tags(compare)).toEqual([["player", null], ["output", "changed"]]);
    const pinIds = (id: string) => ((compare.nodes.find((node) => node.id === id)!.data.__pins ?? []) as Array<{ id: string }>).map((pin) => pin.id);
    const wire = compare.edges[0]!;
    expect(pinIds(wire.source)).toContain(wire.sourceHandle);
    expect(pinIds(wire.target)).toContain(wire.targetHandle);

    // A node saved with its pins keeps them, beside one hydrated.
    const saved = [{ id: "speed", name: "Saved Speed", kind: "data", direction: "in", type: { kind: "float" } }];
    const mixed = scriptDiffGraph({ nodes: [...graph.nodes, { id: "set", type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "call.custom", __pins: saved } }], edges: graph.edges });
    expect(mixed.nodes.find((node) => node.id === "set")!.data.__pins).toEqual(saved);
    expect(mixed.nodes.find((node) => node.id === "output")!.data.__pins).not.toEqual([]);
  });

  it("draws a Material through its editor's hydration: pins and titles from its catalog, the old pin value beside the new", () => {
    const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const wire = (id: string, from: string, to: string, toPin: string) => ({ id, sourceNodeId: from, sourcePinId: "out", targetNodeId: to, targetPinId: toPin });
    const material = (nodes: unknown[], edges: unknown[]) => ({ name: "Water", domain: "surface", shadingModel: "pbr", blendMode: "opaque", twoSided: false, nodes, edges });
    const base = material([node("out", "output.surface", { "default:roughness": [0.5] }), node("mul", "math.multiply")], [wire("e1", "mul", "out", "roughness")]);
    const compare = material(
      [node("out", "output.surface", { "default:roughness": [0.25] }), node("tint", "const.float", { value: [2] }), node("fn", "function.call", { functionGuid: "fresnel" })],
      [wire("e2", "tint", "out", "metallic"), wire("e3", "fn", "out", "specular")],
    );
    const section = diffGraphDocuments(base, compare, "Material").sections[0]!;
    const toGraph = (stored: unknown) => materialDiffGraph(stored, "Material");

    const overlay = canvas(section, toGraph, "overlay");
    expect(tags(overlay)).toEqual([["out", "changed"], ["tint", "added"], ["fn", "added"], ["mul", "removed"]]);
    expect(overlay.edges.map((edge) => edge.id)).toEqual(["e2", "e3", "e1"]);
    expect(changesOn(overlay, "out")).toEqual([{ id: "roughness", name: "Roughness", base: "0.5", compare: "0.25" }]);
    // Hydrated as the Material Graph window draws it.
    const output = overlay.nodes.find((entry) => entry.id === "out")!;
    expect(output.data.title).toBe("Material Output");
    expect((output.data.__pins as Array<{ id: string }>).map((pin) => pin.id)).toContain("roughness");
    // No Material Function is loaded for a diff: its call is drawn by title, without pins.
    expect(overlay.nodes.find((entry) => entry.id === "fn")!.data).toMatchObject({ title: "Material Function", __pins: [] });
    expect(tags(canvas(section, toGraph, "base"))).toEqual([["out", "changed"], ["mul", "removed"]]);
    expect(tags(canvas(section, toGraph, "compare"))).toEqual([["out", "changed"], ["tint", "added"], ["fn", "added"]]);
  });

  it("draws a Material Function's Input and Output nodes with the pins its interface declares", () => {
    const fn = (power: number) => ({
      name: "Fresnel",
      description: "",
      inputs: [{ id: "power", name: "Power", type: "float", defaultValue: [5] }],
      outputs: [{ id: "result", name: "Result", type: "float" }],
      nodes: [
        { id: "in", type: "function.input", position: { x: 0, y: 0 }, properties: {} },
        { id: "pow", type: "math.power", position: { x: 200, y: 0 }, properties: { "default:b": [power] } },
        { id: "out", type: "function.output", position: { x: 400, y: 0 }, properties: {} },
      ],
      edges: [],
    });
    const section = diffGraphDocuments(fn(2), fn(3), "MaterialFunction").sections[0]!;
    const overlay = canvas(section, (stored) => materialDiffGraph(stored, "MaterialFunction"), "overlay");
    expect(tags(overlay)).toEqual([["in", null], ["pow", "changed"], ["out", null]]);
    const pins = (id: string) => (overlay.nodes.find((entry) => entry.id === id)!.data.__pins as Array<{ id: string }>).map((pin) => pin.id);
    expect(pins("in")).toEqual(["power"]);
    expect(pins("out")).toEqual(["result"]);
  });

  it("draws a Particle Graph through its editor's hydration, a Parameter node titled by its version's Parameter", () => {
    const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
    const graph = (emitRate: number, name: string, extra: boolean) => ({
      name: "Sparks",
      materialGuid: null,
      settings: { capacity: 256, loop: "infinite", duration: 1, prewarm: 0, blendMode: "additive", billboard: "camera" },
      parameters: [{ id: "speed", name, type: "float", defaultValue: [1] }],
      nodes: [node("out", "particle.output", { "default:emitRate": [emitRate] }), node("create", "particle.create"), node("p", "input.parameter", { parameterId: "speed" }), ...(extra ? [node("c", "const.float", { value: [3] })] : [])],
      edges: [],
    });
    const section = diffGraphDocuments(graph(30, "Speed", true), graph(60, "Launch Speed", false), "ParticleGraph").sections[0]!;
    const overlay = canvas(section, (stored) => particleDiffGraph(stored), "overlay");
    expect(tags(overlay)).toEqual([["out", "changed"], ["create", null], ["p", null], ["c", "removed"]]);
    expect(changesOn(overlay, "out")).toEqual([{ id: "emitRate", name: "Emit Rate", base: "30", compare: "60" }]);
    expect(overlay.nodes.find((entry) => entry.id === "p")!.data.title).toBe("Launch Speed");
    expect(canvas(section, (stored) => particleDiffGraph(stored), "base").nodes.find((entry) => entry.id === "p")!.data.title).toBe("Speed");
    expect(tags(canvas(section, (stored) => particleDiffGraph(stored), "compare"))).toEqual([["out", "changed"], ["create", null], ["p", null]]);
  });

  it("draws a Behaviour Tree as its editor lays it out: tree node cards, a removed child and its link overlaid", () => {
    const node = (id: string, kind: string, classId: string, children: string[], properties: Record<string, unknown> = {}) => ({ id, kind, classId, children, decorators: [], services: [], properties });
    const tree = (durationMs: number, child: "fail" | "succeed") => ({
      name: "Guard",
      rootId: "root",
      blackboardGuid: null,
      nodes: [node("root", "sequence", "bt.composite.sequence", ["wait", child]), node("wait", "task", "bt.task.wait", [], { durationMs }), node(child, "task", `bt.task.${child}`, [])],
      editorPositions: { root: { x: 0, y: 0 }, wait: { x: -120, y: 180 }, [child]: { x: 120, y: 180 } },
    });
    const section = diffGraphDocuments(tree(1000, "fail"), tree(2000, "succeed"), "BehaviourTree").sections[0]!;
    expect(section.canvas).toBe("behaviour-tree");

    const overlay = canvas(section, behaviourTreeDiffGraph, "overlay");
    expect(tags(overlay)).toEqual([["root", "changed"], ["wait", "changed"], ["succeed", "added"], ["fail", "removed"]]);
    expect(overlay.nodes.every((entry) => entry.type === "bt.node")).toBe(true);
    // At the positions the tree editor stored, not an automatic layout.
    expect(overlay.nodes.find((entry) => entry.id === "wait")!.position).toEqual({ x: -120, y: 180 });
    expect(overlay.edges.map((edge) => edge.id)).toEqual(["bt-root-wait", "bt-root-succeed", "bt-root-fail"]);
    expect(changesOn(overlay, "wait")).toEqual([{ id: "field:properties.durationMs", name: "Duration MS", base: "1000", compare: "2000" }]);
    expect(tags(canvas(section, behaviourTreeDiffGraph, "base"))).toEqual([["root", "changed"], ["wait", "changed"], ["fail", "removed"]]);
  });

  it("draws an Animation Graph's State Machine as its editor does: state cards, and a pair of transitions both ways as one wire", () => {
    const state = (id: string, name: string, x: number) => ({ id, name, position: { x, y: 0 }, stateGraph: { nodes: [], edges: [] } });
    const transition = (id: string, from: string, to: string) => ({ id, fromStateId: from, toStateId: to, blendSeconds: 0.2, priority: 0, ruleGraph: { nodes: [], edges: [] } });
    const graph = (run: boolean, back: boolean) => ({
      name: "Locomotion",
      variables: [],
      stateMachine: {
        entryStateId: "idle",
        states: [state("idle", "Idle", 0), state("walk", "Walk", 240), ...(run ? [state("run", "Run", 480)] : [state("jump", "Jump", 480)])],
        transitions: [transition("t1", "idle", "walk"), ...(back ? [transition("t2", "walk", "idle")] : []), ...(run ? [transition("t3", "walk", "run")] : [])],
        aliases: [],
      },
    });
    const view = diffGraphDocuments(graph(false, false), graph(true, true), "AnimationGraph3D");
    const machine = view.sections.find((entry) => entry.id === "machine")!;
    expect(machine.canvas).toBe("state-machine");
    const toGraph = (stored: unknown) => animStateMachineDiffGraph(stored, "AnimationGraph3D");

    const overlay = canvas(machine, toGraph, "overlay");
    // Idle and Walk changed by their new transitions.
    expect(tags(overlay)).toEqual([["idle", "changed"], ["walk", "changed"], ["run", "added"], ["jump", "removed"]]);
    expect(overlay.nodes.every((entry) => entry.type === "anim.state")).toBe(true);
    // Idle and Walk both ways are one wire, which the base's one way does not duplicate.
    expect(overlay.edges.map((edge) => [edge.id, edge.type])).toEqual([["t1", "animTransitionBoth"], ["t3", "animTransition"]]);
    expect(tags(canvas(machine, toGraph, "base"))).toEqual([["idle", "changed"], ["walk", "changed"], ["jump", "removed"]]);
  });

  it("finds the graph an Actors selection shows: a graph, a node in it, a function, else the first changed graph", () => {
    const node = (id: string, value: number) => ({ id, type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "call.custom", "default:x": value } });
    const doc = (value: number) => ({ nodes: [node("a", 1)], edges: [], members: [{ id: "fn", name: "Sprint", kind: "function" }], functionGraphs: { fn: { nodes: [node("b", value)], edges: [] } } });
    const graph = diffGraphDocuments(doc(1), doc(2), "Class");
    expect(graphDiffSection(graph, "fn/b")).toMatchObject({ section: { id: "fn" }, nodeId: "b" });
    expect(graphDiffSection(graph, "member:fn")).toMatchObject({ section: { id: "fn" }, nodeId: undefined });
    // The Event Graph did not change, so neither it nor its node is shown.
    expect(graphDiffSection(graph, "event/a")).toMatchObject({ section: { id: "fn" }, nodeId: undefined });
    expect(graphDiffSection(graph, null).section?.id).toBe("fn");
  });
});

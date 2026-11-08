import { describe, expect, it } from "vitest";
import { createExtensionSettings, normalizeExtensionContributions, type ExtensionDescriptor } from "@haptic/assets";
import { loadExtensionGameLibraries, type ExtensionGameLibrary } from "@haptic/core";
import { compileGraph, validateGraphs, type GraphEdge, type GraphNode, type LogicGraph, type NodeRegistry } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { loadCompiledModule } from "@haptic/runtime";
import { extensionNodeDefinitions, extensionNodesFingerprint, syncExtensionNodes } from "./extension-nodes";
import { scriptPaletteNodes } from "./script-palette";
import { graphCompileSignature } from "./script-compiler";

const contributes = normalizeExtensionContributions({ nodes: [
  { id: "add", title: "Add Scores", call: "add", category: "Scores", hosts: ["GameInstance"],
    inputs: [{ id: "a", name: "A", type: "int", default: 2 }, { id: "b", name: "B", type: "int" }],
    outputs: [{ id: "sum", name: "Sum", type: "int" }] },
  { id: "split", title: "Split Name", call: "split", pure: true,
    inputs: [{ id: "full", name: "Full Name", type: "string" }],
    outputs: [{ id: "first", name: "First", type: "string" }, { id: "last", name: "Last", type: "string" }] },
  { id: "wait", title: "Wait For Save", call: "wait", latent: true, outputs: [{ id: "saved", name: "Saved", type: "bool" }] },
] });

function extension(overrides: Partial<ExtensionDescriptor["settings"]> = {}): ExtensionDescriptor {
  return {
    extensionGuid: "scores-guid", folderName: "scores", folderPath: "extensions/scores", settingsPath: "extensions/scores/extension.json",
    contentPath: "extensions/scores/assets", source: "project", readOnly: false,
    settings: { ...createExtensionSettings("Score Tools", "scores-guid"), editorOnly: false, libraryName: "scores", contributes, ...overrides },
  };
}

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties };
}

function wire(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string): GraphEdge {
  return { id: `${sourceNodeId}.${sourcePinId}->${targetNodeId}.${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

const library: ExtensionGameLibrary = {
  extensionGuid: "scores-guid", libraryName: "scores", label: "Score Tools", settings: {},
  bundle: { entry: "game.js", modules: [{ path: "game.js", imports: {}, code: [
    "exports.add = (a, b) => a + b;",
    "exports.split = (full) => { const [first, last] = full.split(' '); return { first, last }; };",
    "exports.wait = async () => true;",
  ].join("\n") }] },
};

describe("Extension graph nodes", () => {
  it("call the game library: arguments in pin order, one or several outputs, awaiting latent calls", async () => {
    const registry = createDefaultNodeRegistry();
    registry.registerAll(extensionNodeDefinitions(extension()));
    const graph: LogicGraph = { id: "event-graph", kind: "event", nodes: [
      node(registry, "entry", "flow.entry"),
      node(registry, "add", "extension.scores-guid.add", { "default:b": 5 }),
      node(registry, "split", "extension.scores-guid.split", { "default:full": "Ada Lovelace" }),
      node(registry, "wait", "extension.scores-guid.wait"),
      node(registry, "logSum", "debug.log"),
      node(registry, "logLast", "debug.log"),
      node(registry, "logSaved", "debug.log"),
    ], edges: [
      wire("entry", "execOut", "add", "execIn"),
      wire("add", "execOut", "logSum", "execIn"),
      wire("add", "sum", "logSum", "message"),
      wire("logSum", "execOut", "logLast", "execIn"),
      wire("split", "last", "logLast", "message"),
      wire("logLast", "execOut", "wait", "execIn"),
      wire("wait", "execOut", "logSaved", "execIn"),
      wire("wait", "saved", "logSaved", "message"),
    ] };
    const compiled = compileGraph(graph, { assetGuid: "game", registry });
    const logs: string[] = [];
    const ctx = { formatValue: String, log: (_severity: string, _category: string, message: string) => logs.push(message) };

    const module = await loadCompiledModule(compiled, "game", loadExtensionGameLibraries([library]));
    await (module.run as (context: unknown) => Promise<void>)(ctx);
    expect(logs).toEqual(["7", "Lovelace", "true"]);

    const missing = await loadCompiledModule(compiled, "game-missing");
    await expect((missing.run as (context: unknown) => Promise<void>)(ctx)).rejects.toThrow("Extension library scores has no function add.");
  });

  it("are replaced when extensions change, leaving graph nodes of a removed extension as compile errors", () => {
    const registry = createDefaultNodeRegistry();
    syncExtensionNodes(registry, [extension()]);
    expect(registry.get("extension.scores-guid.add")?.category).toBe("Scores");
    expect(registry.get("extension.scores-guid.split")?.category).toBe("Score Tools");
    expect(extensionNodesFingerprint()).toContain("scores-guid");
    const graph: LogicGraph = { id: "event-graph", kind: "event", nodes: [
      node(registry, "entry", "flow.entry"),
      node(registry, "add", "extension.scores-guid.add"),
    ], edges: [wire("entry", "execOut", "add", "execIn")] };
    const errors = () => validateGraphs([graph], { assetGuid: "game", graphId: "event-graph" } as Parameters<typeof validateGraphs>[1], { registry })
      .filter((entry) => entry.code === "node.missing_extension");
    expect(errors()).toEqual([]);

    const before = graphCompileSignature([{ path: "assets/Game.class.hasset", content: { nodes: [], edges: [] } as never }]);

    syncExtensionNodes(registry, [extension({ editorOnly: true })]);

    // Compile results cached for the old node set are not reused.
    expect(graphCompileSignature([{ path: "assets/Game.class.hasset", content: { nodes: [], edges: [] } as never }])).not.toBe(before);
    expect(registry.get("extension.scores-guid.add")).toBeUndefined();
    expect(extensionNodesFingerprint()).toBe("[]");
    expect(errors()).toEqual([expect.objectContaining({ severity: "error", nodeId: "add", assetGuid: "game" })]);
  });

  it("offer a node limited to Game Instance only in Game Instance graphs and never in editor graphs", () => {
    const registry = createDefaultNodeRegistry();
    syncExtensionNodes(registry, [extension()]);
    const ids = (options: Parameters<typeof scriptPaletteNodes>[1]) =>
      scriptPaletteNodes(registry, options, { injectors: false }).map((entry) => entry.id).filter((id) => id.startsWith("extension."));

    expect(ids({ parentClass: "GameInstance" })).toEqual(["extension.scores-guid.add", "extension.scores-guid.split", "extension.scores-guid.wait"]);
    expect(ids({ parentClass: "Actor" })).toEqual(["extension.scores-guid.split", "extension.scores-guid.wait"]);
    expect(ids({ parentClass: "EditorUtilityObject" })).toEqual([]);
  });
});

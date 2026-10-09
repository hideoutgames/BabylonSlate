import { describe, expect, it } from "vitest";
import {
  assetRef, arrayOf, compileGraph, pin, validateGraphs,
  type GraphNode, type LogicGraph, type NodeRegistry, type PinType,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

const STRING_TYPE: PinType = { kind: "string" };
const ANY_ASSET: PinType = assetRef("");

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}
const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
  id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}:${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
});

/** An Execute JavaScript node that records `[label, ...inputs]`. */
function recorder(registry: NodeRegistry, id: string, label: string, inputs: Array<{ name: string; type: PinType }>) {
  return node(registry, id, "debug.executeJavaScript", {
    inputs, body: `ctx.events.push(${JSON.stringify(label)}, ${inputs.map(input => input.name).join(", ")});`,
  });
}

function runnable(graph: LogicGraph, registry: NodeRegistry) {
  const compiled = compileGraph(graph, { registry, assetGuid: "load-graph" });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${source}\nreturn run;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}

/** A context that records every load call and settles each wait as `success` or with `error`. */
function loadContext(settle: { success: boolean; error?: string }, handle = "handle-1") {
  const calls: unknown[][] = [];
  const events: unknown[] = [];
  const record = (name: string, result?: unknown) => (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  const ctx = {
    events,
    requestAssetLoad: record("requestAssetLoad", handle),
    requestClassLoad: record("requestClassLoad", handle),
    waitForAssetLoad: async (...args: unknown[]) => {
      calls.push(["waitForAssetLoad", ...args]);
      return { success: settle.success, errorMessage: settle.error ?? "" };
    },
    releaseAssetLoad: record("releaseAssetLoad"),
    unloadAsset: record("unloadAsset"),
  };
  return { ctx, calls, events };
}

describe.each([
  // typeId, extra properties, the subject's input pin id and value, its output type, expected request
  ["assets.asyncLoad", { "default:asset": "model" }, "asset", "model", ANY_ASSET,
    ["requestAssetLoad", ["model"], { priority: "Normal", sessionWide: false }], ["waitForAssetLoad", "handle-1"]],
  ["assets.asyncLoadMany", { "default:assets": ["tree", "rock"] }, "assets", ["tree", "rock"], arrayOf(ANY_ASSET),
    ["requestAssetLoad", ["tree", "rock"], { priority: "Normal", sessionWide: false }], ["waitForAssetLoad", "handle-1"]],
  ["assets.asyncLoadClass", { "default:class": "Enemy" }, "class", undefined, undefined,
    ["requestClassLoad", "Enemy", { priority: "Normal", sessionWide: false }], ["waitForAssetLoad", "handle-1"]],
  ["assets.loadBlocking", { "default:asset": "model" }, "asset", "model", ANY_ASSET,
    ["requestAssetLoad", ["model"], { priority: "High", sessionWide: false }], ["waitForAssetLoad", "handle-1", { blocking: true }]],
  ["assets.loadManyBlocking", { "default:assets": ["tree", "rock"] }, "assets", ["tree", "rock"], arrayOf(ANY_ASSET),
    ["requestAssetLoad", ["tree", "rock"], { priority: "High", sessionWide: false }], ["waitForAssetLoad", "handle-1", { blocking: true }]],
  ["assets.loadClassBlocking", { "default:class": "Enemy" }, "class", undefined, undefined,
    ["requestClassLoad", "Enemy", { priority: "High", sessionWide: false }], ["waitForAssetLoad", "handle-1", { blocking: true }]],
] as const)("%s", (typeId, properties, _subjectPin, subject, subjectType, request, wait) => {
  const build = (registry: NodeRegistry, extra: Record<string, unknown> = {}) => {
    const completed = recorder(registry, "completed", "completed", [
      { name: "handle", type: STRING_TYPE }, ...(subjectType ? [{ name: "subject", type: subjectType }] : []),
    ]);
    const failed = recorder(registry, "failed", "failed", [{ name: "error", type: STRING_TYPE }]);
    const load = node(registry, "load", typeId, { ...properties, ...extra });
    const passThrough = load.pins.find(entry => entry.direction === "out" && entry.type.kind !== "exec" && entry.id.endsWith("Out"));
    const graph: LogicGraph = {
      id: "load", kind: "event",
      nodes: [node(registry, "entry", "flow.entry"), load, completed, failed],
      edges: [
        edge("entry", "execOut", "load", "execIn"),
        edge("load", "completed", "completed", "execIn"), edge("load", "failed", "failed", "execIn"),
        edge("load", "handle", "completed", "in_handle"), edge("load", "error", "failed", "in_error"),
        ...(passThrough ? [edge("load", passThrough.id, "completed", "in_subject")] : []),
      ],
    };
    return graph;
  };

  it.each([true, false])("requests the load, waits for its handle and follows the correct branch (success=%s)", async success => {
    const registry = createDefaultNodeRegistry();
    const { ctx, calls, events } = loadContext({ success, error: "Missing model" });
    await runnable(build(registry), registry)(ctx);
    expect(calls).toEqual([[...request], [...wait]]);
    expect(events).toEqual(success ? ["completed", "handle-1", ...(subjectType ? [subject] : [])] : ["failed", "Missing model"]);
  });
});

describe("load options", () => {
  it("forwards an authored priority and Session Wide to an asynchronous load but fixes a blocking load at High", async () => {
    const registry = createDefaultNodeRegistry();
    const run = async (typeId: string) => {
      const { ctx, calls } = loadContext({ success: true });
      await runnable({ id: "g", kind: "event", nodes: [node(registry, "entry", "flow.entry"),
        node(registry, "load", typeId, { "default:asset": "model", "default:priority": "Low", "default:sessionWide": true })],
      edges: [edge("entry", "execOut", "load", "execIn")] }, registry)(ctx);
      return calls[0];
    };
    expect(await run("assets.asyncLoad")).toEqual(["requestAssetLoad", ["model"], { priority: "Low", sessionWide: true }]);
    expect(await run("assets.loadBlocking")).toEqual(["requestAssetLoad", ["model"], { priority: "High", sessionWide: true }]);
  });

  it("offers Priority only on asynchronous loads, as Low, Normal or High defaulting to Normal", () => {
    const registry = createDefaultNodeRegistry();
    const priorityOf = (typeId: string) => registry.get(typeId)!.pins({}).find(entry => entry.id === "priority");
    expect(priorityOf("assets.asyncLoad")).toMatchObject({ type: { kind: "enumRef", guid: "engine:AssetLoadPriority" }, defaultValue: "Normal" });
    expect(["assets.asyncLoadMany", "assets.asyncLoadClass", "assets.requestLoad"].every(typeId => priorityOf(typeId))).toBe(true);
    expect(["assets.loadBlocking", "assets.loadManyBlocking", "assets.loadClassBlocking"].some(typeId => priorityOf(typeId))).toBe(false);
  });
});

describe("load handle nodes", () => {
  it("requests without waiting, waits on the returned handle and releases it only after Completed", async () => {
    const registry = createDefaultNodeRegistry();
    const build = (): LogicGraph => ({
      id: "flow", kind: "event",
      nodes: [node(registry, "entry", "flow.entry"), node(registry, "request", "assets.requestLoad", { "default:assets": ["a", "b"] }),
        node(registry, "wait", "assets.waitForHandle"), node(registry, "release", "assets.releaseHandle"),
        recorder(registry, "failed", "failed", [{ name: "error", type: STRING_TYPE }])],
      edges: [
        edge("entry", "execOut", "request", "execIn"), edge("request", "execOut", "wait", "execIn"),
        edge("request", "handle", "wait", "handle"), edge("wait", "completed", "release", "execIn"),
        edge("request", "handle", "release", "handle"),
        edge("wait", "failed", "failed", "execIn"), edge("wait", "error", "failed", "in_error"),
      ],
    });
    const completed = loadContext({ success: true });
    await runnable(build(), registry)(completed.ctx);
    expect(completed.calls).toEqual([
      ["requestAssetLoad", ["a", "b"], { priority: "Normal", sessionWide: false }],
      ["waitForAssetLoad", "handle-1"],
      ["releaseAssetLoad", "handle-1"],
    ]);
    const failed = loadContext({ success: false, error: "Released" });
    await runnable(build(), registry)(failed.ctx);
    expect(failed.calls.map(call => call[0])).toEqual(["requestAssetLoad", "waitForAssetLoad"]);
    expect(failed.events).toEqual(["failed", "Released"]);
  });

  it("unloads an asset for its owner or, with Session Wide, the session", async () => {
    const registry = createDefaultNodeRegistry();
    const { ctx, calls } = loadContext({ success: true });
    await runnable({ id: "g", kind: "event", nodes: [node(registry, "entry", "flow.entry"),
      node(registry, "unload", "assets.unload", { "default:asset": "tree", "default:sessionWide": true })],
    edges: [edge("entry", "execOut", "unload", "execIn")] }, registry)(ctx);
    expect(calls).toEqual([["unloadAsset", "tree", { sessionWide: true }]]);
  });

  it.each([
    ["assets.getHandleState", "handle", "getAssetLoadHandleState", "Failed"],
    ["assets.getHandleProgress", "handle", "getAssetLoadHandleProgress", 0.25],
    ["assets.getLoadState", "asset", "getAssetLoadState", "Loading"],
  ] as const)("%s reads %s through ctx.%s", async (typeId, pinId, method, value) => {
    const registry = createDefaultNodeRegistry();
    const output = registry.get(typeId)!.pins({}).find(entry => entry.direction === "out")!;
    const read = recorder(registry, "read", "read", [{ name: "value", type: output.type }]);
    const reads: unknown[] = [];
    const events: unknown[] = [];
    await runnable({ id: "g", kind: "event",
      nodes: [node(registry, "entry", "flow.entry"), node(registry, "query", typeId, { [`default:${pinId}`]: "subject" }), read],
      edges: [edge("entry", "execOut", "read", "execIn"), edge("query", output.id, "read", "in_value")] }, registry)(
      { events, [method]: (subject: unknown) => { reads.push(subject); return value; } });
    expect(reads).toEqual(["subject"]);
    expect(events).toEqual(["read", value]);
  });

  it.each([["Loaded", true], ["Loading", false], ["Failed", false], ["Unloaded", false]] as const)(
    "Is Asset Loaded is true only for a Loaded asset (%s)", async (state, expected) => {
      const registry = createDefaultNodeRegistry();
      const events: unknown[] = [];
      await runnable({ id: "g", kind: "event",
        nodes: [node(registry, "entry", "flow.entry"), node(registry, "query", "assets.isLoaded", { "default:asset": "tree" }),
          recorder(registry, "read", "read", [{ name: "value", type: { kind: "bool" } }])],
        edges: [edge("entry", "execOut", "read", "execIn"), edge("query", "loaded", "read", "in_value")] }, registry)(
        { events, getAssetLoadState: () => state });
      expect(events).toEqual(["read", expected]);
    });
});

describe("asset pin types", () => {
  it("accepts typed asset and asset-array wires on every Asset pin without a type mismatch", () => {
    const registry = createDefaultNodeRegistry();
    registry.register({ id: "test.texture", title: "Texture", category: "test", pure: true,
      pins: () => [pin("out", "Out", "out", assetRef("Texture"))], codegen: () => ({ out: '"texture"' }) });
    registry.register({ id: "test.textures", title: "Textures", category: "test", pure: true,
      pins: () => [pin("out", "Out", "out", arrayOf(assetRef("Texture")))], codegen: () => ({ out: '["texture"]' }) });
    const targets: Array<[string, string, string]> = [
      ["assets.asyncLoad", "asset", "test.texture"], ["assets.loadBlocking", "asset", "test.texture"],
      ["assets.unload", "asset", "test.texture"], ["assets.getLoadState", "asset", "test.texture"],
      ["assets.isLoaded", "asset", "test.texture"],
      ["assets.asyncLoadMany", "assets", "test.textures"], ["assets.loadManyBlocking", "assets", "test.textures"],
      ["assets.requestLoad", "assets", "test.textures"],
    ];
    const graph: LogicGraph = { id: "g", kind: "event",
      nodes: [node(registry, "texture", "test.texture"), node(registry, "textures", "test.textures"),
        ...targets.map(([typeId], index) => node(registry, `target${index}`, typeId))],
      edges: targets.map(([, pinId, source], index) => edge(source === "test.texture" ? "texture" : "textures", "out", `target${index}`, pinId)) };
    const diagnostics = validateGraphs([graph], { assetGuid: "asset" }, { registry });
    expect(diagnostics.filter(entry => entry.code === "type.mismatch")).toEqual([]);
  });
});

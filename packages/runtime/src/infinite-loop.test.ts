import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createActor, createDefaultSceneSettings } from "@babylonslate/core";
import { animGraphScriptClassId, createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@babylonslate/debugger";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function jsGraph(
  registry: NodeRegistry,
  body: string,
  eventTypeId: "flow.event.tick" | "flow.event.beginPlay" | "flow.event.init" | "flow.event.end" | "anim.event.update",
): LogicGraph {
  return {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "entry", eventTypeId),
      node(registry, "js", "debug.executeJavaScript", {
        inputs: [],
        outputs: [],
        body,
      }),
    ],
    edges: [edge("e1", "entry", "execOut", "js", "execIn")],
  };
}

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
  assetGuid: string,
  exportName?: string,
): CompiledScript {
  const compiled = compileGraph(graph, {
    assetGuid,
    registry,
    instrumentInfiniteLoops: true,
    exportName,
  });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

function withFunctionExport(
  script: CompiledScript,
  fnGraph: LogicGraph,
  registry: NodeRegistry,
  exportName: string,
): CompiledScript {
  const compiled = compileGraph(fnGraph, {
    assetGuid: script.assetGuid,
    registry,
    exportName,
    instrumentInfiniteLoops: true,
  });
  const extraBody = compiled.source
    .split("\n")
    .filter((line) => !line.startsWith("//# sourceURL"))
    .join("\n");
  return {
    ...script,
    source: `${script.source.replace(/\n$/, "")}\n${extraBody}`,
    anchors: [...script.anchors, ...compiled.anchors],
    entryPoints: [...script.entryPoints, ...compiled.entryPoints],
  };
}

function diagnosticCodes(commands: readonly CommandMessage[]): string[] {
  return commands
    .filter((command) => command.type === "diagnostic")
    .map((command) => command.code);
}

describe("runtime infinite loop guard", () => {
  it.each([true, false])("reports the runaway node with source anchors available: %s", async (withAnchors) => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 5,
      onCommand: (command) => commands.push(command),
    });
    const script = toScript(jsGraph(registry, "while (true) {}", "flow.event.tick"), registry, "Looper", "loop-asset");
    // Browsers may omit sourceURL frames; explicit guard locations must survive.
    if (!withAnchors) script.anchors = [];
    await runtime.loadScripts([script]);
    runtime.spawnScriptedActor({ classId: "Looper" });
    runtime.start();
    runtime.tick();

    expect(diagnosticCodes(commands)).toContain(INFINITE_LOOP_DIAGNOSTIC_CODE);
    expect(diagnosticCodes(commands)).not.toContain("runtime.uncaught");
    expect(runtime.getDiagnostics().entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: INFINITE_LOOP_DIAGNOSTIC_CODE,
          message: "Infinite loop detected",
          nodeId: "js",
          assetGuid: "loop-asset",
          graphId: "event-graph",
        }),
      ]),
    );
    runtime.stop();
  });

  it("reports runtime.infinite_loop from Begin Play without throwing out of spawn", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 5,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(
        jsGraph(registry, "while (true) {}", "flow.event.beginPlay"),
        registry,
        "Looper",
        "loop-asset",
      ),
    ]);
    expect(() => runtime.spawnScriptedActor({ classId: "Looper" })).not.toThrow();
    expect(diagnosticCodes(commands)).toContain(INFINITE_LOOP_DIAGNOSTIC_CODE);
    expect(diagnosticCodes(commands)).not.toContain("runtime.uncaught");
    runtime.stop();
  });

  it.each(["flow.event.init", "flow.event.end"] as const)("contains a Game Instance loop in %s", async (event) => {
    const registry = createDefaultNodeRegistry();
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false,
      includeDebugCommands: true, infiniteLoopDetection: true, loopCount: 5 });
    await runtime.loadScripts([{
      ...toScript(jsGraph(registry, "while (true) {}", event), registry, "GameInstance", "game-instance"),
      parentClassId: "GameInstance",
    }]);
    expect(() => runtime.start()).not.toThrow();
    expect(() => runtime.stop()).not.toThrow();
    expect(runtime.getDiagnostics().entries()).toContainEqual(expect.objectContaining({
      code: INFINITE_LOOP_DIAGNOSTIC_CODE, assetGuid: "game-instance", nodeId: "js",
    }));
  });

  it("contains loops in Animation Object updates outside the Actor tick phase", async () => {
    const registry = createDefaultNodeRegistry();
    const actor = createActor("hero", "Hero", { components: [{ id: "anim", classId: "AnimationGraphComponent", properties: { graphGuid: "graph" } }] });
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false,
      includeDebugCommands: true, infiniteLoopDetection: true, loopCount: 5,
      playScene: { name: "Anim", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [actor] },
      animGraphs: { graph: createDefaultAnimGraph() },
    });
    await runtime.loadScripts([toScript(jsGraph(registry, "while (true) {}", "anim.event.update"), registry, animGraphScriptClassId("graph"), "graph")]);
    runtime.start();
    runtime.realizePlayWorld();
    expect(() => runtime.tick()).not.toThrow();
    expect(runtime.getDiagnostics().entries()).toContainEqual(expect.objectContaining({ code: INFINITE_LOOP_DIAGNOSTIC_CODE, assetGuid: "graph", nodeId: "js" }));
    runtime.stop();
  });

  it("resets the iteration budget at the start of each tick", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 5,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(
        jsGraph(registry, "for (let i = 0; i < 4; i++) { }", "flow.event.tick"),
        registry,
        "Looper",
        "loop-asset",
      ),
    ]);
    runtime.spawnScriptedActor({ classId: "Looper" });
    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(diagnosticCodes(commands)).toEqual([]);
    runtime.stop();
  });

  it("trips on recursive Call Function within one tick", async () => {
    const registry = createDefaultNodeRegistry();
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" },
      { name: "then", typeId: "exec", direction: "out" },
    ];
    const recurseGraph: LogicGraph = {
      id: "Recurse",
      kind: "function",
      nodes: [
        node(registry, "in", "flow.function.input", { pins }),
        node(registry, "call", "functions.call", {
          functionName: "Recurse",
          classId: "Looper",
          implicitSelf: true,
          pins,
        }),
        node(registry, "out", "flow.function.output", { pins }),
      ],
      edges: [
        edge("e1", "in", "exec", "call", "exec"),
        edge("e2", "call", "then", "out", "then"),
      ],
    };
    const eventGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "call", "functions.call", {
          functionName: "Recurse",
          classId: "Looper",
          implicitSelf: true,
          pins,
        }),
      ],
      edges: [edge("e1", "tick", "execOut", "call", "exec")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: true,
      infiniteLoopDetection: true,
      loopCount: 5,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      withFunctionExport(
        toScript(eventGraph, registry, "Looper", "loop-asset"),
        recurseGraph,
        registry,
        "Recurse",
      ),
    ]);
    runtime.spawnScriptedActor({ classId: "Looper" });
    runtime.start();
    runtime.tick();
    expect(diagnosticCodes(commands)).toContain(INFINITE_LOOP_DIAGNOSTIC_CODE);
    expect(diagnosticCodes(commands)).not.toContain("runtime.uncaught");
    runtime.stop();
  });

  it("does not install a real guard when debug commands are stripped", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: false,
      infiniteLoopDetection: true,
      loopCount: 3,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(
        jsGraph(registry, "for (let i = 0; i < 20; i++) { }", "flow.event.tick"),
        registry,
        "Looper",
        "loop-asset",
      ),
    ]);
    runtime.spawnScriptedActor({ classId: "Looper" });
    runtime.start();
    runtime.tick();
    expect(diagnosticCodes(commands)).toEqual([]);
    runtime.stop();
  });

  it("no-ops the guard when infinite loop detection is disabled", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      includeDebugCommands: true,
      infiniteLoopDetection: false,
      loopCount: 3,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(
        jsGraph(registry, "for (let i = 0; i < 20; i++) { }", "flow.event.tick"),
        registry,
        "Looper",
        "loop-asset",
      ),
    ]);
    runtime.spawnScriptedActor({ classId: "Looper" });
    runtime.start();
    runtime.tick();
    expect(diagnosticCodes(commands)).toEqual([]);
    runtime.stop();
  });
});

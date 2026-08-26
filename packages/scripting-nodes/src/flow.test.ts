import { describe, expect, it } from "vitest";
import {
  BOOL,
  EXEC,
  FLOAT,
  compileGraph,
  objectRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { flowNodes } from "./flow";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("flow nodes", () => {
  it("exports at least one node definition", () => {
    expect(flowNodes.length).toBeGreaterThan(0);
    expect(flowNodes[0]?.id).toBeTruthy();
    expect(flowNodes[0]?.category).toBeTruthy();
  });

  it("registers On Command Run pins from the parameter list", () => {
    const command = flowNodes.find((node) => node.id === "flow.event.commandRun");
    expect(command?.title).toBe("Event On Command Run");
    const pins = command?.pins({
      parameters: [{ name: "amount", type: "float" }],
    });
    expect(pins?.some((pin) => pin.id === "amount" && pin.direction === "out")).toBe(
      true,
    );
  });

  it("registers editor utility lifecycle events", () => {
    const ids = flowNodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "flow.event.editorStartup",
        "flow.event.sceneOpen",
        "flow.event.sceneSaved",
        "flow.event.editorShutdown",
      ]),
    );
    expect(
      flowNodes.find((node) => node.id === "flow.event.editorStartup")?.title,
    ).toBe("Event On Editor Startup");
  });

  it("marks editor lifecycle events as editorOnly and leaves Begin Play and Tick runtime", () => {
    const byId = Object.fromEntries(flowNodes.map((node) => [node.id, node]));
    expect(byId["flow.event.editorStartup"]?.editorOnly).toBe(true);
    expect(byId["flow.event.sceneOpen"]?.editorOnly).toBe(true);
    expect(byId["flow.event.sceneSaved"]?.editorOnly).toBe(true);
    expect(byId["flow.event.editorShutdown"]?.editorOnly).toBe(true);
    expect(byId["flow.event.editorBeginPlay"]?.editorOnly).toBe(true);
    expect(byId["flow.event.beginPlay"]?.editorOnly).toBeFalsy();
    expect(byId["flow.event.tick"]?.editorOnly).toBeFalsy();
    expect(byId["flow.event.destroyed"]?.title).toBe("Event On Actor Destroyed");
    expect(byId["flow.event.destroyed"]?.editorOnly).toBeFalsy();
  });

  it("registers On Text Changed as a catalog event", () => {
    const node = flowNodes.find((entry) => entry.id === "flow.event.textChanged");
    expect(node?.title).toBe("Event On Text Changed");
    const pins = node?.pins({}) ?? [];
    expect(pins.some((pin) => pin.id === "text" && pin.direction === "out")).toBe(
      true,
    );
  });

  it("registers Actor collision events with Hit Result and Instigator pins", () => {
    const byId = Object.fromEntries(flowNodes.map((node) => [node.id, node]));
    expect(byId["flow.event.hit"]?.title).toBe("Event On Hit");
    expect(byId["flow.event.beginOverlap"]?.title).toBe(
      "Event On Begin Overlap",
    );
    expect(byId["flow.event.endOverlap"]?.title).toBe("Event On End Overlap");
    expect(byId["flow.event.hit"]?.editorOnly).toBeFalsy();
    const hitPins = byId["flow.event.hit"]?.pins({}) ?? [];
    expect(
      hitPins.map((pin) => ({ id: pin.id, name: pin.name, direction: pin.direction })),
    ).toEqual(
      expect.arrayContaining([
        { id: "hitResult", name: "Hit Result", direction: "out" },
        { id: "otherActor", name: "Other Actor", direction: "out" },
        { id: "location", name: "Location", direction: "out" },
        { id: "normal", name: "Normal", direction: "out" },
      ]),
    );
    const overlapPins = byId["flow.event.beginOverlap"]?.pins({}) ?? [];
    expect(
      overlapPins.map((pin) => ({ id: pin.id, name: pin.name })),
    ).toEqual(
      expect.arrayContaining([{ id: "instigator", name: "Instigator" }]),
    );
  });

  it("compiles On Hit pins from ctx.args", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "hit", "flow.event.hit"),
        node(registry, "logHit", "debug.log"),
        node(registry, "logOther", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "hit",
          sourcePinId: "execOut",
          targetNodeId: "logHit",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "hit",
          sourcePinId: "hitResult",
          targetNodeId: "logHit",
          targetPinId: "message",
        },
        {
          id: "e3",
          sourceNodeId: "logHit",
          sourcePinId: "execOut",
          targetNodeId: "logOther",
          targetPinId: "execIn",
        },
        {
          id: "e4",
          sourceNodeId: "hit",
          sourcePinId: "otherActor",
          targetNodeId: "logOther",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.entryPoints.some((entry) => entry.event === "onHit")).toBe(
      true,
    );
    expect(compiled.source).toContain("ctx.args.hitResult");
    expect(compiled.source).toContain("ctx.args.otherActor");
  });

  it("maps function Input pins from member inputs as outputs", () => {
    const input = flowNodes.find((node) => node.id === "flow.function.input");
    expect(input?.title).toBe("Input");
    const pins = input?.pins({
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "amount", typeId: "float", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [
        { id: "exec", direction: "out" },
        { id: "amount", direction: "out" },
      ],
    );
  });

  it("maps function Output pins from member outputs as inputs", () => {
    const output = flowNodes.find((node) => node.id === "flow.function.output");
    expect(output?.title).toBe("Output");
    const pins = output?.pins({
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "result", typeId: "float", direction: "out" },
      ],
    });
    expect(pins?.map((pin) => ({ id: pin.id, direction: pin.direction }))).toEqual(
      [
        { id: "then", direction: "in" },
        { id: "result", direction: "in" },
      ],
    );
  });

  it("maps custom event data pins as outputs beside Then", () => {
    const custom = flowNodes.find((node) => node.id === "flow.event.custom");
    const pins = custom?.pins({
      name: "On Hit",
      pins: [
        { name: "amount", typeId: "float", direction: "out" },
        { name: "stunned", typeId: "bool", direction: "out" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(
      pins?.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execOut", direction: "out", type: EXEC },
      { id: "amount", direction: "out", type: FLOAT },
      { id: "stunned", direction: "out", type: BOOL },
    ]);
  });

  it("omits Target on same-class Call Custom Event and keeps it for other classes", () => {
    const call = flowNodes.find((node) => node.id === "flow.event.call");
    expect(call?.title).toBe("Call Custom Event");
    const selfPins = call?.pins({
      name: "On Hit",
      classId: "Hero",
      implicitSelf: true,
      pins: [
        { name: "amount", typeId: "float", direction: "out" },
        { name: "then", typeId: "exec", direction: "out" },
      ],
    });
    expect(
      selfPins?.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", direction: "in", type: EXEC },
      { id: "execOut", direction: "out", type: EXEC },
      { id: "amount", direction: "in", type: FLOAT },
    ]);
    const otherPins = call?.pins({
      name: "On Alert",
      classId: "Guard",
      implicitSelf: false,
      pins: [{ name: "amount", typeId: "float", direction: "out" }],
    });
    expect(otherPins?.some((pin) => pin.id === "target")).toBe(true);
    expect(otherPins?.find((pin) => pin.id === "target")?.type).toEqual(
      objectRef("Guard"),
    );
  });

  it("registers Call Parent Event with passthrough data pins", () => {
    const callParent = flowNodes.find(
      (node) => node.id === "flow.event.callParent",
    );
    expect(callParent?.title).toBe("Call Parent Event");
    const pins = callParent?.pins({
      eventType: "flow.event.custom",
      eventName: "On Hit",
      parentClassId: "HeroBase",
      pins: [{ name: "amount", typeId: "float", direction: "out" }],
    });
    expect(
      pins?.map((pin) => ({
        id: pin.id,
        name: pin.name,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", name: "exec", direction: "in", type: EXEC },
      { id: "execOut", name: "then", direction: "out", type: EXEC },
      { id: "amount", name: "amount", direction: "in", type: FLOAT },
      { id: "amount__out", name: "amount", direction: "out", type: FLOAT },
    ]);
  });

  it("compiles Call Parent Event to ctx.invokeEvent on the parent class", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "cp", "flow.event.callParent", {
          eventType: "flow.event.beginPlay",
          eventName: "Begin Play",
          parentClassId: "HeroBase",
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "cp",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "a",
      registry,
    });
    expect(compiled.source).toContain(
      'ctx.invokeEvent("HeroBase", "onBeginPlay", {  });',
    );
  });

  it("compiles function Output data pins as a return object", () => {
    const registry = createDefaultNodeRegistry();
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" },
      { name: "height", typeId: "float", direction: "in" },
      { name: "then", typeId: "exec", direction: "out" },
      { name: "result", typeId: "float", direction: "out" },
    ];
    const graph: LogicGraph = {
      id: "Jump",
      kind: "function",
      nodes: [
        node(registry, "in", "flow.function.input", { pins }),
        node(registry, "out", "flow.function.output", { pins }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "in",
          sourcePinId: "exec",
          targetNodeId: "out",
          targetPinId: "then",
        },
        {
          id: "e2",
          sourceNodeId: "in",
          sourcePinId: "height",
          targetNodeId: "out",
          targetPinId: "result",
        },
      ],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "a",
      registry,
      exportName: "Jump",
    });
    expect(compiled.source).toMatch(/return\s*\{/);
    expect(compiled.source).toContain("result");
    expect(compiled.source).toContain("ctx.args");
  });
});

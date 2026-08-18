import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createDefaultSceneSettings,
  userInterfaceClassId,
  USER_INTERFACE_ENGINE_CLASS_ID,
} from "@babylonslate/core";
import {
  ButtonWidget,
  ImageWidget,
  UserInterface,
} from "@babylonslate/object-model";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";
import { applyUiRuntimeControl } from "./worker-control";

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

function toScript(
  graph: LogicGraph,
  registry: NodeRegistry,
  classId: string,
  assetGuid: string,
  extras: Partial<CompiledScript> = {},
): CompiledScript {
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    ...extras,
  };
}

const HUD_GUID = "hud-guid";
const HUD_CLASS_ID = userInterfaceClassId(HUD_GUID);

function hudWidgets() {
  return [
    { id: "root", kind: "Canvas", name: "Canvas" },
    { id: "play-btn", kind: "Button", name: "Play" },
    { id: "logo", kind: "Image", name: "Logo" },
  ];
}

describe("apply / remove UserInterface from a class graph", () => {
  it("creates a typed UserInterface, emits uiApply with class metadata, and removes by object", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
        node(registry, "remove", "ui.removeFromViewport"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "apply", "execIn"),
        edge("e2", "apply", "execOut", "remove", "execIn"),
        edge("e3", "apply", "instance", "remove", "instance"),
      ],
    };

    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "HudHost", "hud-host-asset"),
    ]);
    const actorsBefore = runtime.getWorld().getActors().length;
    runtime.spawnScriptedActor({ classId: "HudHost" });
    runtime.start();
    runtime.tick();

    const apply = commands.filter((command) => command.type === "uiApply");
    const remove = commands.filter((command) => command.type === "uiRemove");
    expect(apply).toEqual([
      {
        type: "uiApply",
        instanceId: "ui-1",
        classId: HUD_CLASS_ID,
        assetGuid: HUD_GUID,
      },
    ]);
    expect(remove).toEqual([{ type: "uiRemove", instanceId: "ui-1" }]);
    expect(runtime.getUserInterface("ui-1")).toBeUndefined();
    expect(runtime.listUserInterfaces()).toEqual([]);
    expect(
      runtime.getWorld().getActors().filter((actor) => actor.classId === HUD_CLASS_ID),
    ).toEqual([]);
    expect(runtime.getWorld().getActors().length).toBe(actorsBefore + 1);
    runtime.stop();
  });

  it("does not emit apply when the asset guid is empty", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: "  " }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "EmptyHud", "empty-hud-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "EmptyHud" });
    runtime.start();
    runtime.tick();
    expect(commands.filter((command) => command.type === "uiApply")).toEqual([]);
    expect(runtime.listUserInterfaces()).toEqual([]);
    runtime.stop();
  });

  it("accepts a namespaced class id and does not spawn a rogue Actor", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_CLASS_ID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(graph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const applied = commands.find((command) => command.type === "uiApply");
    expect(applied).toEqual({
      type: "uiApply",
      instanceId: "ui-1",
      classId: HUD_CLASS_ID,
      assetGuid: HUD_GUID,
    });
    const mounted = runtime.getUserInterface("ui-1");
    expect(mounted).toBeInstanceOf(UserInterface);
    expect(mounted?.classId).toBe(HUD_CLASS_ID);
    expect(mounted?.assetGuid).toBe(HUD_GUID);
    expect(
      runtime.getWorld().getActors().some((actor) => actor instanceof UserInterface),
    ).toBe(false);
    expect(
      runtime.getWorld().getActors().some((actor) => actor.classId === HUD_CLASS_ID),
    ).toBe(false);
    runtime.stop();
  });
});

describe("mounted UserInterface lifecycle", () => {
  it("runs UI onBeginPlay when applied and ticks only while mounted", async () => {
    const registry = createDefaultNodeRegistry();
    const uiScript: CompiledScript = {
      assetGuid: HUD_GUID,
      classId: HUD_CLASS_ID,
      parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      source: [
        "//# sourceURL=babylonslate:///hud-guid.js",
        "export function onBeginPlay(ctx) { ctx.setVariable('ready', true); }",
        "export function onTick(ctx) { ctx.setVariable('ticks', Number(ctx.getVariable('ticks') ?? 0) + 1); }",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        { name: "onTick", event: "onTick", isAsync: false },
      ],
      variables: [
        { name: "ready", type: "bool", defaultValue: false },
        { name: "ticks", type: "float", defaultValue: 0 },
      ],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
    });
    await runtime.loadScripts([
      uiScript,
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const ui = runtime.getUserInterface("ui-1");
    expect(ui).toBeInstanceOf(UserInterface);
    expect(ui?.getVariable("ready")).toBe(true);
    expect(ui?.getVariable("ticks")).toBe(0);

    runtime.start();
    runtime.tick();
    runtime.tick();
    expect(ui?.getVariable("ticks")).toBe(2);

    runtime.removeUserInterface(ui!);
    runtime.tick();
    expect(ui?.getVariable("ticks")).toBe(2);
    expect(ui?.destroyed).toBe(true);
    expect(runtime.getUserInterface("ui-1")).toBeUndefined();
    runtime.stop();
  });

  it("creates concrete Widget objects from document metadata and scopes getWidget / setWidgetVisible", async () => {
    const registry = createDefaultNodeRegistry();
    const uiScript: CompiledScript = {
      assetGuid: HUD_GUID,
      classId: HUD_CLASS_ID,
      parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      source: [
        "//# sourceURL=babylonslate:///hud-guid-widgets.js",
        "export function onBeginPlay(ctx) {",
        "  const widget = ctx.getWidget('play-btn');",
        "  ctx.setWidgetVisible(widget, false);",
        "}",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    runtime.registerUserInterfaceDocument(HUD_GUID, hudWidgets());
    await runtime.loadScripts([
      uiScript,
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const ui = runtime.getUserInterface("ui-1");
    expect(ui?.widgets.map((widget) => widget.widgetId)).toEqual([
      "root",
      "play-btn",
      "logo",
    ]);
    const play = ui?.widgets.find((widget) => widget.widgetId === "play-btn");
    const logo = ui?.widgets.find((widget) => widget.widgetId === "logo");
    expect(play).toBeInstanceOf(ButtonWidget);
    expect(logo).toBeInstanceOf(ImageWidget);
    expect(play?.owner).toBe(ui);
    expect(
      commands.filter((command) => command.type === "uiSetVisible"),
    ).toEqual([
      {
        type: "uiSetVisible",
        instanceId: "ui-1",
        widgetId: "play-btn",
        visible: false,
      },
    ]);
    runtime.removeUserInterface("ui-1");
    expect(play?.destroyed).toBe(true);
    expect(logo?.destroyed).toBe(true);
    expect(play?.owner).toBeNull();
    runtime.stop();
  });

  it("keeps multiple instances of one class independent", async () => {
    const registry = createDefaultNodeRegistry();
    const uiScript: CompiledScript = {
      assetGuid: HUD_GUID,
      classId: HUD_CLASS_ID,
      parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      source: [
        "//# sourceURL=babylonslate:///hud-guid-multi.js",
        "export function onBeginPlay(ctx) { ctx.setVariable('label', 'applied'); }",
        "export function onTick(ctx) { ctx.setVariable('ticks', Number(ctx.getVariable('ticks') ?? 0) + 1); }",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        { name: "onTick", event: "onTick", isAsync: false },
      ],
      variables: [
        { name: "label", type: "string", defaultValue: "" },
        { name: "ticks", type: "float", defaultValue: 0 },
      ],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "applyA", "ui.applyToViewport", { asset: HUD_GUID }),
        node(registry, "applyB", "ui.applyToViewport", { asset: HUD_CLASS_ID }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "applyA", "execIn"),
        edge("e2", "applyA", "execOut", "applyB", "execIn"),
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    runtime.registerUserInterfaceDocument(HUD_GUID, hudWidgets());
    await runtime.loadScripts([
      uiScript,
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const first = runtime.getUserInterface("ui-1");
    const second = runtime.getUserInterface("ui-2");
    expect(first).toBeInstanceOf(UserInterface);
    expect(second).toBeInstanceOf(UserInterface);
    expect(first).not.toBe(second);
    first!.setVariable("label", "one");
    second!.setVariable("label", "two");
    expect(first!.getVariable("label")).toBe("one");
    expect(second!.getVariable("label")).toBe("two");
    expect(first!.widgets.find((widget) => widget.widgetId === "play-btn")).not.toBe(
      second!.widgets.find((widget) => widget.widgetId === "play-btn"),
    );

    runtime.start();
    runtime.tick();
    expect(first!.getVariable("ticks")).toBe(1);
    expect(second!.getVariable("ticks")).toBe(1);

    runtime.removeUserInterface(first!);
    runtime.tick();
    expect(first!.destroyed).toBe(true);
    expect(first!.getVariable("ticks")).toBe(1);
    expect(second!.destroyed).toBe(false);
    expect(second!.getVariable("ticks")).toBe(2);
    expect(runtime.listUserInterfaces()).toEqual([second]);
    runtime.stop();
  });

  it("dispatches widget events onto the owning UI object with widget ref/id/value", async () => {
    const registry = createDefaultNodeRegistry();
    const uiGraph: LogicGraph = {
      id: "ui-graph",
      kind: "event",
      nodes: [
        node(registry, "click", "flow.event.custom", {
          name: "onWidgetClick",
          pins: [
            { name: "widgetId", typeId: "string", direction: "out" },
            { name: "value", typeId: "string", direction: "out" },
          ],
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "click", "execOut", "log", "execIn"),
        edge("e2", "click", "widgetId", "log", "message"),
      ],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    runtime.registerUserInterfaceDocument(HUD_GUID, hudWidgets());
    await runtime.loadScripts([
      toScript(uiGraph, registry, HUD_CLASS_ID, HUD_GUID, {
        parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      }),
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    const ui = runtime.getUserInterface("ui-1");
    const play = ui?.widgets.find((widget) => widget.widgetId === "play-btn");
    runtime.dispatchUiWidgetEvent({
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "click",
    });
    const logs = commands.filter((command) => command.type === "log");
    expect(logs.some((command) => String(command.message).includes("play-btn"))).toBe(
      true,
    );
    expect(play).toBeInstanceOf(ButtonWidget);
    runtime.stop();
  });

  it("dispatches pointer enter onto onMouseEnter on the owning UI", async () => {
    const registry = createDefaultNodeRegistry();
    const uiGraph: LogicGraph = {
      id: "ui-graph",
      kind: "event",
      nodes: [
        node(registry, "enter", "flow.event.mouseEnter"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "enter", "execOut", "log", "execIn"),
        edge("e2", "enter", "widgetId", "log", "message"),
      ],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    runtime.registerUserInterfaceDocument(HUD_GUID, hudWidgets());
    await runtime.loadScripts([
      toScript(uiGraph, registry, HUD_CLASS_ID, HUD_GUID, {
        parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      }),
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    runtime.dispatchUiWidgetEvent({
      type: "uiWidgetEvent",
      instanceId: "ui-1",
      widgetId: "play-btn",
      kind: "pointerEnter",
    });
    const logs = commands.filter((command) => command.type === "log");
    expect(logs.some((command) => String(command.message).includes("play-btn"))).toBe(
      true,
    );
    runtime.stop();
  });

  it("tears down every mounted UI on change-scene and stop", async () => {
    const registry = createDefaultNodeRegistry();
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
        node(registry, "change", "scene.change", { scene: "Level2" }),
      ],
      edges: [
        edge("e1", "begin", "execOut", "apply", "execIn"),
        edge("e2", "apply", "execOut", "change", "execIn"),
      ],
    };
    const commands: CommandMessage[] = [];
    const level2 = {
      name: "Level2",
      viewportMode: "3d" as const,
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
      sceneLibrary: { Level2: level2 },
      sceneGuidByKey: { Level2: "level-2" },
    });
    runtime.registerUserInterfaceDocument(HUD_GUID, hudWidgets());
    await runtime.loadScripts([
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    expect(commands.some((command) => command.type === "uiApply")).toBe(true);
    expect(commands.filter((command) => command.type === "uiRemove")).toEqual([
      { type: "uiRemove", instanceId: "ui-1" },
    ]);
    expect(runtime.listUserInterfaces()).toEqual([]);

    const again: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const stopRuntime = createInProcessRuntime({
      seed: 2,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await stopRuntime.loadScripts([
      toScript(again, registry, "HudHost", "hud-host-asset-2"),
    ]);
    stopRuntime.spawnScriptedActor({ classId: "HudHost" });
    expect(stopRuntime.listUserInterfaces()).toHaveLength(1);
    stopRuntime.stop();
    expect(stopRuntime.listUserInterfaces()).toEqual([]);
    expect(
      commands.filter((command) => command.type === "uiRemove").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not auto-spawn a UserInterface script class as an Actor", async () => {
    const registry = createDefaultNodeRegistry();
    const uiGraph: LogicGraph = {
      id: "ui-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "tick", "flow.event.tick"),
      ],
      edges: [],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      toScript(uiGraph, registry, HUD_CLASS_ID, HUD_GUID, {
        parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      }),
    ]);
    expect(runtime.spawnScriptedActor({ classId: HUD_CLASS_ID })).toBeNull();
    expect(
      commands.filter((command) => command.type === "spawn"),
    ).toEqual([]);
    expect(runtime.getWorld().getActors()).toEqual([]);
    runtime.stop();
  });
});

describe("worker UI control routing", () => {
  it("loadUserInterfaces and uiWidgetEvent reach the runtime driver", async () => {
    const registry = createDefaultNodeRegistry();
    const uiGraph: LogicGraph = {
      id: "ui-graph",
      kind: "event",
      nodes: [
        node(registry, "value", "flow.event.custom", {
          name: "onWidgetValue",
          pins: [{ name: "widgetId", typeId: "string", direction: "out" }],
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "value", "execOut", "log", "execIn"),
        edge("e2", "value", "widgetId", "log", "message"),
      ],
    };
    const hostGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "apply", "ui.applyToViewport", { asset: HUD_GUID }),
      ],
      edges: [edge("e1", "begin", "execOut", "apply", "execIn")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      onCommand: (command) => commands.push(command),
    });
    expect(
      applyUiRuntimeControl(runtime, {
        type: "loadUserInterfaces",
        documents: [{ guid: HUD_GUID, widgets: hudWidgets() }],
      }),
    ).toBe(true);
    await runtime.loadScripts([
      toScript(uiGraph, registry, HUD_CLASS_ID, HUD_GUID, {
        parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      }),
      toScript(hostGraph, registry, "HudHost", "hud-host-asset"),
    ]);
    runtime.spawnScriptedActor({ classId: "HudHost" });
    expect(runtime.getUserInterface("ui-1")?.widgets).toHaveLength(3);
    expect(
      applyUiRuntimeControl(runtime, {
        type: "uiWidgetEvent",
        instanceId: "ui-1",
        widgetId: "play-btn",
        kind: "value",
        value: 0.25,
      }),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.type === "log" && String(command.message).includes("play-btn"),
      ),
    ).toBe(true);
    runtime.stop();
  });
});

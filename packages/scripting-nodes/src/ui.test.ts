import { describe, expect, it } from "vitest";
import {
  classRef,
  compileGraph,
  createEmptyLogicGraph,
  objectRef,
  pin,
  EXEC,
  type CodegenContext,
  type LogicGraph,
} from "@babylonslate/scripting";
import { widgetClassIdForKind } from "@babylonslate/core";
import { createDefaultNodeRegistry } from "./index";
import {
  boundGetWidgetEntries,
  uiGetWidgetNodeId,
  uiNodes,
} from "./ui";

function mockCtx(): CodegenContext & { emits: string[] } {
  const emits: string[] = [];
  return {
    emits,
    graph: createEmptyLogicGraph("g"),
    node: {
      id: "n1",
      typeId: "test",
      position: { x: 0, y: 0 },
      pins: [],
      properties: {},
    },
    indent: "  ",
    input: (name) => `IN_${name}`,
    output: (name) => `_out_${name}`,
    emit: (s) => {
      emits.push(s);
    },
    hoist: () => {},
    requestAsync: () => {},
  };
}

describe("ui nodes", () => {
  it("applies a UserInterface class and returns a UserInterface instance", () => {
    const apply = uiNodes.find((node) => node.id === "ui.applyToViewport");
    expect(apply?.title).toBe("Apply User Interface");
    const pins = apply!.pins({});
    expect(pins.map((entry) => entry.id)).toEqual([
      "execIn",
      "execOut",
      "asset",
      "instance",
    ]);
    expect(pins.find((entry) => entry.id === "asset")?.type).toEqual(
      classRef("UserInterface"),
    );
    expect(pins.find((entry) => entry.id === "instance")?.type).toEqual(
      objectRef("UserInterface"),
    );
    const ctx = mockCtx();
    apply!.codegen(ctx);
    expect(ctx.emits.join("\n")).toContain(
      "_out_instance = ctx.applyUserInterface(IN_asset)",
    );
  });

  it("removes an applied UserInterface by object ref", () => {
    const remove = uiNodes.find((node) => node.id === "ui.removeFromViewport");
    expect(remove?.title).toBe("Remove User Interface");
    const pins = remove!.pins({});
    expect(pins.map((entry) => entry.id)).toEqual(["execIn", "execOut", "instance"]);
    expect(pins.find((entry) => entry.id === "instance")?.type).toEqual(
      objectRef("UserInterface"),
    );
    const ctx = mockCtx();
    remove!.codegen(ctx);
    expect(ctx.emits.join("\n")).toContain(
      "ctx.removeUserInterface(IN_instance)",
    );
  });

  it("sets visibility from a Widget object ref, not a raw string", () => {
    const setVis = uiNodes.find((node) => node.id === "ui.setVisibility");
    const pins = setVis!.pins({});
    expect(pins.find((entry) => entry.id === "widget")?.type).toEqual(
      objectRef("Widget"),
    );
    const ctx = mockCtx();
    setVis!.codegen(ctx);
    expect(ctx.emits.join("\n")).toContain(
      "ctx.setWidgetVisible(IN_widget, IN_visible)",
    );
  });

  it("Get Widget returns the concrete subclass ref for a bound widget", () => {
    const getWidget = uiNodes.find((node) => node.id === uiGetWidgetNodeId);
    expect(getWidget?.pure).toBe(true);
    const pins = getWidget!.pins({
      widgetId: "play-btn",
      widgetName: "Play Button",
      widgetKind: "Button",
    });
    expect(pins).toEqual([
      expect.objectContaining({
        id: "widget",
        name: "Play Button",
        direction: "out",
        type: objectRef("ButtonWidget"),
      }),
    ]);
    const ctx = mockCtx();
    ctx.node.properties = {
      widgetId: "play-btn",
      widgetName: "Play Button",
      widgetKind: "Button",
    };
    expect(getWidget!.codegen(ctx)).toEqual({
      "Play Button": 'ctx.getWidget("play-btn")',
    });
  });
});

describe("bound Get Widget catalog", () => {
  it("injects one Get Widget entry per stable widget id and name", () => {
    const entries = boundGetWidgetEntries([
      { id: "play-btn", name: "Play Button", kind: "Button" },
      { id: "logo", name: "Logo", kind: "Image" },
    ]);
    expect(entries).toEqual([
      {
        id: `${uiGetWidgetNodeId}:play-btn`,
        nodeType: uiGetWidgetNodeId,
        title: "Get Play Button",
        widgetId: "play-btn",
        widgetName: "Play Button",
        widgetKind: "Button",
        classId: widgetClassIdForKind("Button"),
        pinType: objectRef("ButtonWidget"),
        defaultData: {
          widgetId: "play-btn",
          widgetName: "Play Button",
          widgetKind: "Button",
          title: "Get Play Button",
        },
      },
      {
        id: `${uiGetWidgetNodeId}:logo`,
        nodeType: uiGetWidgetNodeId,
        title: "Get Logo",
        widgetId: "logo",
        widgetName: "Logo",
        widgetKind: "Image",
        classId: widgetClassIdForKind("Image"),
        pinType: objectRef("ImageWidget"),
        defaultData: {
          widgetId: "logo",
          widgetName: "Logo",
          widgetKind: "Image",
          title: "Get Logo",
        },
      },
    ]);
  });
});

describe("ui compile goldens", () => {
  it("compiles Apply / Remove / Get Widget with typed refs", () => {
    const registry = createDefaultNodeRegistry();
    const applyPins = registry.get("ui.applyToViewport")!.pins({});
    const removePins = registry.get("ui.removeFromViewport")!.pins({});
    const getPins = registry.get(uiGetWidgetNodeId)!.pins({
      widgetId: "play-btn",
      widgetName: "Play Button",
      widgetKind: "Button",
    });
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
          id: "apply",
          typeId: "ui.applyToViewport",
          position: { x: 160, y: 0 },
          pins: applyPins,
          properties: { "default:asset": "UserInterface:hud-guid" },
        },
        {
          id: "get",
          typeId: uiGetWidgetNodeId,
          position: { x: 320, y: 80 },
          pins: getPins,
          properties: {
            widgetId: "play-btn",
            widgetName: "Play Button",
            widgetKind: "Button",
          },
        },
        {
          id: "hide",
          typeId: "ui.setVisibility",
          position: { x: 480, y: 0 },
          pins: registry.get("ui.setVisibility")!.pins({}),
          properties: {},
        },
        {
          id: "remove",
          typeId: "ui.removeFromViewport",
          position: { x: 640, y: 0 },
          pins: removePins,
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "apply",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "apply",
          sourcePinId: "execOut",
          targetNodeId: "hide",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "hide",
          sourcePinId: "execOut",
          targetNodeId: "remove",
          targetPinId: "execIn",
        },
        {
          id: "e4",
          sourceNodeId: "apply",
          sourcePinId: "instance",
          targetNodeId: "remove",
          targetPinId: "instance",
        },
        {
          id: "e5",
          sourceNodeId: "get",
          sourcePinId: "widget",
          targetNodeId: "hide",
          targetPinId: "widget",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "hero", registry });
    expect(compiled.source).toContain("ctx.applyUserInterface(");
    expect(compiled.source).toContain('ctx.getWidget("play-btn")');
    expect(compiled.source).toContain("ctx.setWidgetVisible(");
    expect(compiled.source).toContain("ctx.removeUserInterface(");
    expect(applyPins.find((entry) => entry.id === "asset")?.type).toEqual(
      classRef("UserInterface"),
    );
    expect(getPins.find((entry) => entry.id === "widget")?.type).toEqual(
      objectRef("ButtonWidget"),
    );
  });
});

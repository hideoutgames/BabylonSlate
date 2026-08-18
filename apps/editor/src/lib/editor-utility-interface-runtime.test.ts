import { describe, expect, it, vi } from "vitest";
import type { ScriptHost } from "@babylonslate/runtime";
import {
  bindEditorUtilityWidgetEvent,
  compileEditorUtilityInterfaceLogic,
  createEditorUtilityInterfaceHost,
} from "./editor-utility-interface-runtime";

describe("compileEditorUtilityInterfaceLogic", () => {
  it("compiles payload.logic and does not treat empty graphs as scripts", () => {
    expect(
      compileEditorUtilityInterfaceLogic("assets/Tools.eui.babasset", {
        logic: { nodes: [], edges: [] },
      }),
    ).toEqual([]);
    const scripts = compileEditorUtilityInterfaceLogic(
      "assets/Tools.eui.babasset",
      {
        logic: {
          nodes: [
            {
              id: "start",
              type: "flow.event.editorBeginPlay",
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: "log",
              type: "debug.log",
              position: { x: 200, y: 0 },
              data: { message: "eui-up", category: "Editor" },
            },
          ],
          edges: [
            {
              id: "e1",
              source: "start",
              target: "log",
              sourceHandle: "execOut",
              targetHandle: "execIn",
            },
          ],
        },
      },
    );
    expect(scripts).toHaveLength(1);
    expect(
      scripts[0]?.entryPoints.some((entry) => entry.event === "onEditorBeginPlay"),
    ).toBe(true);
  });
});

describe("createEditorUtilityInterfaceHost", () => {
  it("loads compiled logic and fires Editor On Begin Play", async () => {
    const logs: string[] = [];
    const scripts = compileEditorUtilityInterfaceLogic(
      "assets/Tools.eui.babasset",
      {
        logic: {
          nodes: [
            {
              id: "start",
              type: "flow.event.editorBeginPlay",
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: "log",
              type: "debug.log",
              position: { x: 200, y: 0 },
              data: { message: "eui-up", category: "Editor" },
            },
          ],
          edges: [
            {
              id: "e1",
              source: "start",
              target: "log",
              sourceHandle: "execOut",
              targetHandle: "execIn",
            },
          ],
        },
      },
    );
    const host = createEditorUtilityInterfaceHost({
      log: (_severity, _category, message) => {
        logs.push(message);
      },
    });
    await host.loadAll(scripts);
    host.beginPlay();
    expect(logs).toEqual(["eui-up"]);
    host.dispose();
  });

  it("forwards a widget click into the loaded class", () => {
    const invokeEvent = vi.fn();
    const host = {
      classIds: () => ["Tools"],
      invokeEvent,
    } as Pick<ScriptHost, "classIds" | "invokeEvent">;
    bindEditorUtilityWidgetEvent(host, {
      kind: "click",
      widgetId: "btn",
    });
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onWidgetClick", null, {
      widgetId: "btn",
    });
  });

  it("forwards mouse enter, exit, press, and release into the loaded class", () => {
    const invokeEvent = vi.fn();
    const host = {
      classIds: () => ["Tools"],
      invokeEvent,
    } as Pick<ScriptHost, "classIds" | "invokeEvent">;
    bindEditorUtilityWidgetEvent(host, {
      kind: "pointerEnter",
      widgetId: "btn",
    });
    bindEditorUtilityWidgetEvent(host, {
      kind: "pointerExit",
      widgetId: "btn",
    });
    bindEditorUtilityWidgetEvent(host, {
      kind: "pointerDown",
      widgetId: "btn",
    });
    bindEditorUtilityWidgetEvent(host, {
      kind: "pointerUp",
      widgetId: "btn",
    });
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onMouseEnter", null, {
      widgetId: "btn",
    });
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onMouseExit", null, {
      widgetId: "btn",
    });
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onMousePress", null, {
      widgetId: "btn",
    });
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onMouseRelease", null, {
      widgetId: "btn",
    });
  });
});

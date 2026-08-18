import { describe, expect, it, vi } from "vitest";
import { userInterfaceClassId } from "@babylonslate/core";
import type { ScriptHost } from "@babylonslate/runtime";
import {
  bindEditorUtilityWidgetEvent,
  collectNestedUtilityLogicSources,
  compileEditorUtilityInterfaceLogic,
  createEditorUtilityInterfaceHost,
  nestedUtilitySlots,
} from "./editor-utility-interface-runtime";

function editorBeginPlayLogic(message: string) {
  return {
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
        data: { message, category: "Editor" },
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
  };
}

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

  it("routes a prefixed widget id to the nested class with the local remainder", () => {
    const invokeEvent = vi.fn();
    const nestedClassId = userInterfaceClassId("chip-guid");
    bindEditorUtilityWidgetEvent(
      {
        classIds: () => ["Tools", nestedClassId],
        invokeEvent,
      } as Pick<ScriptHost, "classIds" | "invokeEvent">,
      { kind: "click", widgetId: "chip/inner-btn" },
      [{ slotId: "chip", classId: nestedClassId }],
    );
    expect(invokeEvent).toHaveBeenCalledWith(nestedClassId, "onWidgetClick", null, {
      widgetId: "inner-btn",
    });
    expect(invokeEvent).not.toHaveBeenCalledWith(
      "Tools",
      "onWidgetClick",
      null,
      expect.anything(),
    );
  });

  it("keeps unprefixed widget events on the host class, not nested scripts", () => {
    const invokeEvent = vi.fn();
    const nestedClassId = userInterfaceClassId("chip-guid");
    bindEditorUtilityWidgetEvent(
      {
        classIds: () => ["Tools", nestedClassId],
        invokeEvent,
      } as Pick<ScriptHost, "classIds" | "invokeEvent">,
      { kind: "click", widgetId: "host-btn" },
      [{ slotId: "chip", classId: nestedClassId }],
    );
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onWidgetClick", null, {
      widgetId: "host-btn",
    });
    expect(invokeEvent).not.toHaveBeenCalledWith(
      nestedClassId,
      "onWidgetClick",
      null,
      expect.anything(),
    );
  });
});

describe("collectNestedUtilityLogicSources", () => {
  it("walks nested UserInterface widgets and skips cycles", () => {
    const nested = collectNestedUtilityLogicSources(
      {
        rootId: "canvas",
        widgets: {
          canvas: { id: "canvas", kind: "Canvas", children: ["chip"] },
          chip: {
            id: "chip",
            kind: "UserInterface",
            nestedUiGuid: "chip-guid",
            children: [],
          },
        },
      },
      (guid) => {
        if (guid === "chip-guid") {
          return {
            path: "assets/Chip.ui.babasset",
            payload: {
              rootId: "canvas",
              widgets: {
                canvas: { id: "canvas", kind: "Canvas", children: ["inner"] },
                inner: {
                  id: "inner",
                  kind: "UserInterface",
                  nestedUiGuid: "chip-guid",
                  children: [],
                },
              },
              logic: editorBeginPlayLogic("chip-up"),
            },
          };
        }
        return null;
      },
    );
    expect(nested).toEqual([
      {
        slotId: "chip",
        guid: "chip-guid",
        path: "assets/Chip.ui.babasset",
        payload: expect.objectContaining({ logic: expect.any(Object) }),
      },
    ]);
    expect(nestedUtilitySlots(nested)).toEqual([
      { slotId: "chip", classId: userInterfaceClassId("chip-guid") },
    ]);
  });
});

describe("compileEditorUtilityInterfaceLogic nested", () => {
  it("compiles nested UserInterface logic as additional scripts", () => {
    const scripts = compileEditorUtilityInterfaceLogic(
      "assets/Tools.eui.babasset",
      { logic: editorBeginPlayLogic("eui-up") },
      [
        {
          slotId: "chip",
          guid: "chip-guid",
          path: "assets/Chip.ui.babasset",
          payload: { logic: editorBeginPlayLogic("chip-up") },
        },
      ],
    );
    const nested = scripts.find(
      (script) => script.classId === userInterfaceClassId("chip-guid"),
    );
    expect(nested).toBeTruthy();
    expect(
      nested?.entryPoints.some((entry) => entry.event === "onEditorBeginPlay"),
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { ScriptHost } from "@babylonslate/runtime";
import { compileGraphDocuments } from "../services/script-compiler";
import {
  EDITOR_UTILITY_EVENTS,
  editorUtilityBootEvents,
  fireEditorUtilityEvent,
  selectEditorUtilityGraphs,
  shutdownEditorUtilityHost,
} from "./editor-utility-scripts";

const emptyGraph = { nodes: [], edges: [] };

describe("selectEditorUtilityGraphs", () => {
  const parentOf = (id: string) =>
    id === "LevelTools" || id === "EditorUtilityObject" || id === "Actor"
      ? "BObject"
      : id === "Tools"
        ? "EditorUtilityObject"
        : null;

  it("keeps only registered EditorUtilityObject class graphs", () => {
    const selected = selectEditorUtilityGraphs(
      [
        {
          path: "assets/Hero.class.babasset",
          content: emptyGraph,
        },
        {
          path: "assets/Tools.class.babasset",
          content: emptyGraph,
        },
        {
          path: "assets/OtherTools.class.babasset",
          content: emptyGraph,
        },
      ],
      {
        headers: {
          "assets/Hero.class.babasset": {
            type: "Class",
            parentClass: "Actor",
            name: "Hero",
          },
          "assets/Tools.class.babasset": {
            type: "Class",
            parentClass: "EditorUtilityObject",
            name: "Tools",
          },
          "assets/OtherTools.class.babasset": {
            type: "Class",
            parentClass: "EditorUtilityObject",
            name: "OtherTools",
          },
        },
        parentOf,
        registeredClassIds: ["Tools"],
      },
    );
    expect(selected.map((graph) => graph.path)).toEqual([
      "assets/Tools.class.babasset",
    ]);
  });

  it("ignores a registered id that is not an EditorUtilityObject", () => {
    const selected = selectEditorUtilityGraphs(
      [
        {
          path: "assets/Hero.class.babasset",
          content: emptyGraph,
        },
      ],
      {
        headers: {
          "assets/Hero.class.babasset": {
            type: "Class",
            parentClass: "Actor",
            name: "Hero",
          },
        },
        parentOf,
        registeredClassIds: ["Hero"],
      },
    );
    expect(selected).toEqual([]);
  });
});

describe("editor utility ScriptHost events", () => {
  it("dispatches On Editor Startup for loaded utility classes", async () => {
    const logs: string[] = [];
    const host = new ScriptHost({
      log: (_severity, _category, message) => {
        logs.push(message);
      },
      print: () => {},
      destroyActor: () => {},
      executeConsoleCommand: () => ({ success: true, output: "" }),
      delay: async () => {},
      reportError: (error) => {
        throw error;
      },
    });
    const scripts = compileGraphDocuments([
      {
        path: "assets/Tools.class.babasset",
        content: {
          nodes: [
            {
              id: "start",
              type: "flow.event.editorStartup",
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: "log",
              type: "debug.log",
              position: { x: 200, y: 0 },
              data: { message: "editor-up", category: "Editor" },
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
    ]);
    expect(scripts[0]?.entryPoints.some((entry) => entry.event === "onEditorStartup")).toBe(
      true,
    );
    await host.load(scripts[0]!);
    fireEditorUtilityEvent(host, EDITOR_UTILITY_EVENTS.startup);
    expect(logs).toEqual(["editor-up"]);
  });

  it("boots On Editor Startup then On Scene Open when a scene tab is already open", () => {
    expect(editorUtilityBootEvents(false)).toEqual([EDITOR_UTILITY_EVENTS.startup]);
    expect(editorUtilityBootEvents(true)).toEqual([
      EDITOR_UTILITY_EVENTS.startup,
      EDITOR_UTILITY_EVENTS.sceneOpen,
    ]);
  });

  it("fires On Editor Shutdown when disposing a started host", () => {
    const invokeEvent = vi.fn();
    shutdownEditorUtilityHost(
      { classIds: () => ["Tools"], invokeEvent },
      true,
    );
    expect(invokeEvent).toHaveBeenCalledWith("Tools", "onEditorShutdown");
    invokeEvent.mockClear();
    shutdownEditorUtilityHost(
      { classIds: () => ["Tools"], invokeEvent },
      false,
    );
    expect(invokeEvent).not.toHaveBeenCalled();
  });
});

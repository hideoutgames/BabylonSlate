import { describe, expect, it } from "vitest";
import { compileGraph, EVENT_BY_TYPE_ID, eventNameForEntry } from "./compile";
import type { GraphNode } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC } from "./types";

function entry(typeId: string): GraphNode {
  return {
    id: "n",
    typeId,
    position: { x: 0, y: 0 },
    pins: [],
    properties: {},
  };
}

describe("editor utility events", () => {
  it("maps EditorUtilityObject lifecycle nodes to ScriptHost events", () => {
    expect(EVENT_BY_TYPE_ID["flow.event.editorStartup"]).toBe("onEditorStartup");
    expect(EVENT_BY_TYPE_ID["flow.event.sceneOpen"]).toBe("onSceneOpen");
    expect(EVENT_BY_TYPE_ID["flow.event.sceneSaved"]).toBe("onSceneSaved");
    expect(EVENT_BY_TYPE_ID["flow.event.editorShutdown"]).toBe(
      "onEditorShutdown",
    );
    expect(eventNameForEntry(entry("flow.event.editorStartup"))).toBe(
      "onEditorStartup",
    );
    expect(EVENT_BY_TYPE_ID["flow.event.editorBeginPlay"]).toBe(
      "onEditorBeginPlay",
    );
    expect(eventNameForEntry(entry("flow.event.editorBeginPlay"))).toBe(
      "onEditorBeginPlay",
    );
    expect(EVENT_BY_TYPE_ID["flow.event.mouseEnter"]).toBeUndefined();
    expect(EVENT_BY_TYPE_ID["flow.event.mouseExit"]).toBeUndefined();
    expect(EVENT_BY_TYPE_ID["flow.event.mousePress"]).toBeUndefined();
    expect(EVENT_BY_TYPE_ID["flow.event.mouseRelease"]).toBeUndefined();
    expect(EVENT_BY_TYPE_ID["flow.event.widgetClick"]).toBeUndefined();
    expect(eventNameForEntry(entry("flow.event.widgetClick"))).toBeUndefined();
    expect(EVENT_BY_TYPE_ID["flow.event.destroyed"]).toBe("onDestroyed");
    expect(eventNameForEntry(entry("flow.event.destroyed"))).toBe("onDestroyed");
  });

  it("maps On Text Changed to onTextChanged", () => {
    expect(EVENT_BY_TYPE_ID["flow.event.textChanged"]).toBe("onTextChanged");
    expect(eventNameForEntry(entry("flow.event.textChanged"))).toBe(
      "onTextChanged",
    );
  });

  it("maps On Audio Finished to onAudioFinished", () => {
    expect(EVENT_BY_TYPE_ID["flow.event.audioFinished"]).toBe("onAudioFinished");
    expect(eventNameForEntry(entry("flow.event.audioFinished"))).toBe(
      "onAudioFinished",
    );
  });

  it("stamps componentId on compiled entry points", () => {
    const registry = new NodeRegistry();
    registry.register({
      id: "flow.event.onClick",
      title: "Event On Click",
      category: "flow",
      pure: true,
      pins: () => [pin("execOut", "then", "out", EXEC)],
      codegen: () => {},
    });
    const pins = registry.get("flow.event.onClick")!.pins({});
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [
          {
            id: "a",
            typeId: "flow.event.onClick",
            position: { x: 0, y: 0 },
            pins,
            properties: { componentId: "btn-1" },
          },
          {
            id: "b",
            typeId: "flow.event.onClick",
            position: { x: 0, y: 80 },
            pins,
            properties: { componentId: "btn-2" },
          },
        ],
        edges: [],
      },
      { assetGuid: "a", registry },
    );
    expect(compiled.entryPoints).toEqual([
      expect.objectContaining({
        event: "onClick",
        componentId: "btn-1",
      }),
      expect.objectContaining({
        event: "onClick",
        componentId: "btn-2",
      }),
    ]);
  });

  it("maps Actor collision event nodes to ScriptHost events", () => {
    expect(EVENT_BY_TYPE_ID["flow.event.hit"]).toBe("onHit");
    expect(EVENT_BY_TYPE_ID["flow.event.beginOverlap"]).toBe("onBeginOverlap");
    expect(EVENT_BY_TYPE_ID["flow.event.endOverlap"]).toBe("onEndOverlap");
    expect(eventNameForEntry(entry("flow.event.hit"))).toBe("onHit");
    expect(eventNameForEntry(entry("flow.event.beginOverlap"))).toBe(
      "onBeginOverlap",
    );
    expect(eventNameForEntry(entry("flow.event.endOverlap"))).toBe(
      "onEndOverlap",
    );
  });

  it("maps Animation Object lifecycle nodes to ScriptHost events", () => {
    expect(EVENT_BY_TYPE_ID["anim.event.initialize"]).toBe(
      "onInitializeAnimation",
    );
    expect(EVENT_BY_TYPE_ID["anim.event.update"]).toBe("onUpdateAnimation");
    expect(eventNameForEntry(entry("anim.event.initialize"))).toBe(
      "onInitializeAnimation",
    );
  });
});

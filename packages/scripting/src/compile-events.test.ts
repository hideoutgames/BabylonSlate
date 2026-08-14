import { describe, expect, it } from "vitest";
import { EVENT_BY_TYPE_ID, eventNameForEntry } from "./compile";
import type { GraphNode } from "./ir";

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
  });
});

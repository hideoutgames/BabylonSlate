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
    expect(EVENT_BY_TYPE_ID["flow.event.editorBeginPlay"]).toBe(
      "onEditorBeginPlay",
    );
    expect(eventNameForEntry(entry("flow.event.editorBeginPlay"))).toBe(
      "onEditorBeginPlay",
    );
    expect(EVENT_BY_TYPE_ID["flow.event.mouseEnter"]).toBe("onMouseEnter");
    expect(EVENT_BY_TYPE_ID["flow.event.mouseExit"]).toBe("onMouseExit");
    expect(EVENT_BY_TYPE_ID["flow.event.mousePress"]).toBe("onMousePress");
    expect(EVENT_BY_TYPE_ID["flow.event.mouseRelease"]).toBe("onMouseRelease");
    expect(EVENT_BY_TYPE_ID["flow.event.widgetClick"]).toBe("onWidgetClick");
    expect(EVENT_BY_TYPE_ID["flow.event.destroyed"]).toBe("onDestroyed");
    expect(eventNameForEntry(entry("flow.event.destroyed"))).toBe("onDestroyed");
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

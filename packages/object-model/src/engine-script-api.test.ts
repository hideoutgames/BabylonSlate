import { describe, expect, it } from "vitest";
import {
  engineScriptApiFor,
  engineScriptEventsFor,
  engineScriptFunctionsFor,
  engineScriptVariablesFor,
  ENGINE_CLASS_SCRIPT_APIS,
} from "./engine-script-api";

function names(
  entries: readonly { name: string }[] | undefined,
): string[] {
  return (entries ?? []).map((entry) => entry.name);
}

describe("engine script API catalog", () => {
  it("lists Collider overlap and hit events", () => {
    const events = engineScriptEventsFor("ColliderComponent");
    expect(events.map((event) => event.eventType)).toEqual([
      "flow.event.hit",
      "flow.event.beginOverlap",
      "flow.event.endOverlap",
    ]);
    expect(events.map((event) => event.exportName)).toEqual([
      "onHit",
      "onBeginOverlap",
      "onEndOverlap",
    ]);
  });

  it("exposes 2DButton mouse events and Hit Test, not SceneLayerActor natives", () => {
    expect(engineScriptApiFor("SceneLayerActor")).toBeUndefined();
    const button = engineScriptApiFor("2DButtonComponent");
    expect(names(button?.variables)).toEqual(["Hit Test"]);
    expect(button?.variables?.[0]?.propertyKey).toBe("hitTest");
    expect(engineScriptEventsFor("2DButtonComponent").map((event) => event.eventType)).toEqual(
      [
        "flow.event.onMouseEnter",
        "flow.event.onMouseLeave",
        "flow.event.onClick",
        "flow.event.onPressStart",
        "flow.event.onPressEnd",
      ],
    );
  });

  it("exposes Text3D Set Text, text properties, and On Text Changed", () => {
    const api = engineScriptApiFor("Text3DComponent");
    expect(names(api?.variables)).toEqual(["Text", "Size", "Color", "Font"]);
    expect(api?.variables?.map((entry) => entry.propertyKey)).toEqual([
      "text",
      "size",
      "color",
      "fontAssetGuid",
    ]);
    const setText = engineScriptFunctionsFor("Text3DComponent").find(
      (entry) => entry.name === "Set Text",
    );
    expect(setText?.runtime).toBe("setText");
    expect(setText?.pins).toEqual(
      expect.arrayContaining([
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "text", typeId: "string", direction: "in" },
      ]),
    );
    expect(engineScriptEventsFor("Text3DComponent")).toEqual([
      expect.objectContaining({
        name: "On Text Changed",
        eventType: "flow.event.textChanged",
        exportName: "onTextChanged",
      }),
    ]);
  });

  it("does not invent APIs for every engine component", () => {
    expect(engineScriptApiFor("BlockingVolumeComponent")).toBeUndefined();
    expect(engineScriptApiFor("MeshComponent")).toBeUndefined();
    expect(engineScriptEventsFor("CameraComponent")).toEqual([]);
    expect(ENGINE_CLASS_SCRIPT_APIS.every((api) => api.classId !== "Actor")).toBe(
      true,
    );
  });
});

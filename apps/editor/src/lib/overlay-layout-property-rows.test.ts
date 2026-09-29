import { describe, expect, it } from "vitest";
import { createActor, resolveOverlayLayout, type SerializedComponent } from "@babylonslate/core";
import { defaultPropertiesFor } from "../panels/add-component-catalog";
import { overlayLayoutPropertyRows } from "./overlay-layout-property-rows";

describe("SceneLayer layout authoring", () => {
  it("switches a box between fixed and content sizing and updates measured child layout", () => {
    const box: SerializedComponent = { id: "box", classId: "2DHorizontalBoxComponent", properties: defaultPropertiesFor("2DHorizontalBoxComponent") };
    const update = (key: string, value: unknown) => { box.properties[key] = value; };
    const before = overlayLayoutPropertyRows("actor", box, update);
    const mode = before.find(r => r.id.endsWith("-widthMode"));
    expect(mode?.kind).toBe("enum");
    if (mode?.kind === "enum") mode.onChange("content");
    expect(overlayLayoutPropertyRows("actor", box, update).some(r => r.id.endsWith("-width"))).toBe(false);
    const actor = createActor("actor", "Layout", { classId: "SceneLayerActor", components: [box, { id: "one", classId: "2DMaterialComponent", parentId: "box", properties: {} }, { id: "two", classId: "2DMaterialComponent", parentId: "box", properties: {} }] });
    expect(resolveOverlayLayout([actor]).entries.get("actor/box")?.rect.width).toBe(2);
  });
});

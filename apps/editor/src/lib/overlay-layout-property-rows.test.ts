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

it("authors virtual item classes and safe-area edges through typed rows", () => {
  const virtual: SerializedComponent = { id: "list", classId: "2DVirtualizedListComponent", properties: defaultPropertiesFor("2DVirtualizedListComponent") };
  const rows = overlayLayoutPropertyRows("actor", virtual, (key, value) => { virtual.properties[key] = value; }, [{ id: "Entry", name: "Entry", group: "Project" }]);
  const itemClass = rows.find(row => row.label === "Item Class");
  if (itemClass?.kind !== "enum") throw new Error("Missing item class picker");
  itemClass.onChange("Entry");
  expect(virtual.properties.itemClassId).toBe("Entry");
  const safe: SerializedComponent = { id: "safe", classId: "2DSafeAreaComponent", properties: defaultPropertiesFor("2DSafeAreaComponent") };
  const left = overlayLayoutPropertyRows("actor", safe, (key, value) => { safe.properties[key] = value; }).find(row => row.label === "Safe Left");
  if (left?.kind !== "boolean") throw new Error("Missing safe-area edge toggle");
  left.onChange(false);
  expect(safe.properties.safeLeft).toBe(false);
});

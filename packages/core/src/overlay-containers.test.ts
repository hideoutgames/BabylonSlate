import { describe, expect, it } from "vitest";
import { createActor, identitySerializedTransform, type SerializedComponent } from "./scene";
import { resolveOverlayLayout } from "./overlay-layout";
import { virtualizedOverlayWindow } from "./overlay-containers";

const component = (id: string, classId: string, properties: Record<string, unknown> = {}, parentId: string | null = null): SerializedComponent => ({ id, classId, properties, parentId, transform: identitySerializedTransform() });
describe("SceneLayer containers", () => {
  it("keeps virtualized grid item positions stable when only a middle window exists", () => {
    const root = createActor("root", "Root", { components: [component("grid", "2DVirtualizedGridComponent", {
      width: 6, height: 2, itemClassId: "Tile", itemCount: 10_000, itemWidth: 2, itemHeight: 1, scrollY: 500, overscan: 1,
    })] });
    const tile = createActor("tile", "Tile", { parentId: "root", components: [component("visual", "2DMaterialComponent")] });
    const result = resolveOverlayLayout([root, tile], { virtualItems: { tile: { containerId: "grid", index: 1503 } } });
    expect(result.entries.get("root/grid")).toMatchObject({ virtual: { first: 1497, end: 1509, columns: 3, count: 10_000 }, scroll: { y: 500, maxY: 3332 } });
    expect(result.entries.get("tile")).toMatchObject({ rect: { x: -2, y: -0.5, width: 2, height: 1 }, realized: true });
    expect(tile.transform.position).toEqual([0, 0, 0]);
  });

  it("virtualizes authored list children and all of their descendants at viewport boundaries", () => {
    const root = createActor("root", "Root", { components: [component("list", "2DVirtualizedListComponent", { width: 4, height: 2, scrollY: 2, overscan: 0 })] });
    const items = Array.from({ length: 6 }, (_, index) => createActor(`item${index}`, "Item", { parentId: "root", components: [component("visual", "2DMaterialComponent")] }));
    const result = resolveOverlayLayout([root, ...items]);
    expect(items.filter(item => result.entries.get(item.id)?.realized).map(item => item.id)).toEqual(["item2", "item3"]);
    expect(result.entries.get("item1/visual")).toMatchObject({ realized: false, interactive: false });
    expect(result.entries.get("item2/visual")).toMatchObject({ realized: true, interactive: true });
  });

  it("keeps horizontal windows and hostile dimensions finite and bounds their resource demand", () => {
    expect(virtualizedOverlayWindow("2DVirtualizedListComponent", { itemClassId: "Item", itemCount: 20, itemWidth: 2, scrollAxis: "horizontal", scrollX: 100, overscan: 0 }, 4, 2))
      .toMatchObject({ first: 18, end: 20, scrollX: 36, scrollY: 0 });
    const range = virtualizedOverlayWindow("2DVirtualizedGridComponent", { itemClassId: "Item", itemCount: 1e308, columns: 1e308, overscan: 1e308, itemHeight: 0.00000001 }, 1e6, 1e6);
    expect(range.end - range.first).toBeLessThanOrEqual(2048);
    expect(Number.isFinite(range.contentHeight)).toBe(true);
    expect(virtualizedOverlayWindow("2DVirtualizedListComponent", { itemClassId: "Item", itemCount: 100 }, 0, 0)).toMatchObject({ first: 0, end: 0 });
  });

  it("combines device and authored safe insets in scaled containers and respects disabled sides", () => {
    const root = createActor("root", "Root", { components: [component("safe", "2DSafeAreaComponent", { width: 10, height: 8, insetLeft: 1, safeRight: false }), component("child", "2DMaterialComponent", { widthMode: "fill", heightMode: "fill" }, "safe")] });
    root.transform.scale = [2, 2, 1];
    const result = resolveOverlayLayout([root], { safeAreaInsets: { left: 2, right: 9, top: 2, bottom: 0 } });
    expect(result.entries.get("root/child")!.rect).toEqual({ x: 2, y: -1, width: 16, height: 14 });
    expect(root.components[1]!.transform).toEqual(identitySerializedTransform());
  });

  it("clips a MaskPanel's contents and intersects an actor Mask across siblings and descendants", () => {
    const mask = component("mask", "2DMaskComponent", { width: 2, height: 4 });
    mask.transform!.position = [0.5, 0, 0];
    const root = createActor("root", "Root", { components: [
      component("panel", "2DMaskPanelComponent", { width: 4, height: 4, paddingLeft: 1 }),
      component("content", "2DMaterialComponent", { width: 8, height: 8, widthMode: "fixed", heightMode: "fixed" }, "panel"),
      component("sibling", "2DMaterialComponent"), mask,
    ] });
    const child = createActor("child", "Child", { parentId: "root", components: [component("visual", "2DMaterialComponent")] });
    const result = resolveOverlayLayout([root, child]);
    expect(result.entries.get("root/panel")!.clip).toEqual({ x: 0.5, y: 0, width: 2, height: 4 });
    expect(result.entries.get("root/content")!.clip).toEqual({ x: 0.5, y: 0, width: 2, height: 4 });
    expect(result.entries.get("root/sibling")!.clip).toEqual({ x: 0.5, y: 0, width: 2, height: 4 });
    expect(result.entries.get("child/visual")!.clip).toEqual({ x: 0.5, y: 0, width: 2, height: 4 });
    root.components = root.components.filter(c => c.id !== "mask");
    const panelOnly = resolveOverlayLayout([root]);
    expect(panelOnly.entries.get("root/panel")!.clip).toBeNull();
    expect(panelOnly.entries.get("root/content")!.clip).toEqual({ x: 0.5, y: 0, width: 3, height: 4 });
  });

  it("lets a mask-only helper actor clip its parent actor without occupying a layout slot", () => {
    const root = createActor("root", "Root", { components: [component("visual", "2DMaterialComponent")] });
    const helper = createActor("mask", "Mask", { parentId: "root", components: [component("mask", "2DMaskComponent", { width: 0.5, height: 0.5 })] });
    helper.transform.position[0] = 0.25;
    const result = resolveOverlayLayout([root, helper]);
    expect(result.entries.get("root/visual")!.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(result.entries.get("root/visual")!.clip).toEqual({ x: 0.25, y: 0, width: 0.5, height: 0.5 });
  });
});

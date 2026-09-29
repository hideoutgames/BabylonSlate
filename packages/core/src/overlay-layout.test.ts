import { describe, expect, it } from "vitest";
import { createActor, identitySerializedTransform, type SerializedActor, type SerializedComponent } from "./scene";
import { resolveOverlayLayout, overlayLayoutKey } from "./overlay-layout";

const component = (id: string, classId: string, properties: Record<string, unknown> = {}, parentId: string | null = null): SerializedComponent => ({ id, classId, properties, parentId, transform: identitySerializedTransform() });
function actor(id: string, components: SerializedComponent[], parentId: string | null = null): SerializedActor {
  return { ...createActor("SceneLayerActor", id), id, parentId, components };
}
describe("nested SceneLayer layout", () => {
  it("makes hidden actors and disabled or hidden component ancestors unavailable to scroll input", () => {
    const hiddenActor = actor("hidden", [component("scroll", "2DScrollBoxComponent")]);
    hiddenActor.visible = false;
    const source = [hiddenActor, actor("child", [component("scroll", "2DScrollBoxComponent")], "hidden"),
      actor("visible", [
        component("disabled", "2DOverlayBoxComponent", { enabled: false }),
        component("disabled-scroll", "2DScrollBoxComponent", {}, "disabled"),
        component("hidden", "2DOverlayBoxComponent", { visible: false }),
        component("hidden-scroll", "2DScrollBoxComponent", {}, "hidden"),
        component("active-scroll", "2DScrollBoxComponent"),
      ])];
    const result = resolveOverlayLayout(source);
    for (const key of ["hidden/scroll", "child/scroll", "visible/disabled-scroll", "visible/hidden-scroll"]) {
      expect(result.entries.get(key)).toMatchObject({ interactive: false });
    }
    expect(result.entries.get("visible/active-scroll")).toMatchObject({ interactive: true });
  });

  it("measures standalone visual bounds on request without arranging or cloning authored transforms", () => {
    const surface = component("surface", "2DTextureComponent", { textureGuid: "icon", paddingLeft: 4 });
    surface.transform!.position = [4, 2, 0];
    const child = component("child", "2DMaterialComponent", {}, "surface");
    child.transform!.position = [1, 1, 0];
    const source = [actor("standalone", [surface, child])];
    source[0]!.transform.position = [5, 1, 0];
    const before = structuredClone(source);
    const result = resolveOverlayLayout(source, { includeUnmanagedBounds: true, textureSize: () => ({ width: 200, height: 100 }) });
    expect(result.entries.get("standalone/surface")!.rect).toEqual({ x: 9, y: 3, width: 2, height: 1 });
    expect(result.entries.get("standalone/child")!.rect).toEqual({ x: 10, y: 4, width: 1, height: 1 });
    expect(result.actors).toBe(source);
    expect(source).toEqual(before);
  });

  it("applies a root box's padding once and combines actor-level padding helpers without mutating authored data", () => {
    const source = [actor("root", [
      component("box", "2DOverlayBoxComponent", { width: 10, height: 8, paddingLeft: 1, paddingRight: 1 }),
      component("padding", "2DPaddingComponent", { paddingTop: 1, paddingBottom: 1 }),
      component("content", "2DMaterialComponent", { widthMode: "fill", heightMode: "fill" }, "box"),
      component("focus", "2DFocusTargetComponent", {}, "box"),
      component("button", "2DButtonComponent", {}, "box"),
    ])];
    const before = structuredClone(source);
    const result = resolveOverlayLayout(source);
    expect(result.entries.get("root/box")!.rect).toEqual({ x: 0, y: 0, width: 10, height: 8 });
    expect(result.entries.get("root/content")!.rect).toEqual({ x: 0, y: 0, width: 8, height: 6 });
    expect(result.actors[0]!.components.find(c => c.id === "content")!.transform!.scale).toEqual([8, 6, 1]);
    expect(source).toEqual(before);
  });
  it("keeps interaction-only sibling components and helper actors out of a box's flow", () => {
    const source = [
      actor("root", [component("column", "2DVerticalBoxComponent", { width: 4, height: 8, gap: 1 }), component("focus", "2DFocusTargetComponent", {}, "column")]),
      actor("first", [component("surface", "2DMaterialComponent"), component("button", "2DButtonComponent"), component("focus", "2DFocusTargetComponent")], "root"),
      actor("helper", [component("focus", "2DFocusTargetComponent"), component("anchor", "2DAnchorComponent")], "root"),
      actor("second", [component("surface", "2DMaterialComponent")], "root"),
    ];
    const result = resolveOverlayLayout(source);
    expect(result.entries.get("first")!.rect).toEqual({ x: -1.5, y: 3.5, width: 1, height: 1 });
    expect(result.entries.get("second")!.rect).toEqual({ x: -1.5, y: 1.5, width: 1, height: 1 });
  });
  it("insets a visual parent's component children and uses Painter's actual default bounds", () => {
    const source = [actor("root", [component("surface", "2DPainterComponent"),
      component("padding", "2DPaddingComponent", { paddingLeft: 1, paddingRight: 2, paddingTop: 3, paddingBottom: 1 }, "surface"),
      component("content", "2DMaterialComponent", { widthMode: "fill", heightMode: "fill" }, "surface"),
    ])];
    const result = resolveOverlayLayout(source);
    expect(result.entries.get("root/surface")!.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(result.entries.get("root/content")!.rect).toEqual({ x: -0.5, y: -1, width: 7, height: 6 });
  });
  it("reports the scroll content viewport and scale independently of ancestor clipping", () => {
    const root = actor("root", [component("scroll", "2DScrollBoxComponent", { width: 6, height: 4, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }),
      component("column", "2DVerticalBoxComponent", { width: 4, height: 10 }, "scroll")]);
    root.transform.scale = [2, 3, 1];
    const scroll = resolveOverlayLayout([root]).entries.get("root/scroll")!.scroll!;
    expect(scroll).toMatchObject({ viewport: { x: 0, y: -1.5, width: 8, height: 9 }, scaleX: 2, scaleY: 3, maxY: 7 });
  });
  it("arranges Outliner children with nested component boxes, weighted spacers and parent padding", () => {
    const source = [
      actor("root", [component("column", "2DVerticalBoxComponent", { width: 10, height: 10, gap: 1 }), component("inset", "2DPaddingComponent", { paddingTop: 1, paddingBottom: 1 }, "column")]),
      actor("row", [component("horizontal", "2DHorizontalBoxComponent", { widthMode: "fill", height: 2, gap: 1 }), component("left", "2DMaterialComponent", {}, "horizontal"), component("gap", "2DSpacerComponent", { widthMode: "fill" }, "horizontal"), component("right", "2DMaterialComponent", {}, "horizontal")], "root"),
      actor("bottom", [component("visual", "2DMaterialComponent")], "root"),
    ];
    const result = resolveOverlayLayout(source);
    expect(result.actors[1]!.transform.position.slice(0, 2)).toEqual([0, 3]);
    expect(result.actors[2]!.transform.position.slice(0, 2)).toEqual([-4.5, 0.5]);
    expect(result.entries.get("row/left")!.rect.x).toBe(-4.5);
    expect(result.entries.get("row/right")!.rect.x).toBe(4.5);
    expect(source[1]!.transform.position).toEqual([0, 0, 0]);
  });
  it("clamps scroll to measured content and intersects nested viewports", () => {
    const root = actor("root", [
      component("scroll", "2DScrollBoxComponent", { width: 4, height: 4, scrollY: 99 }),
      component("column", "2DVerticalBoxComponent", { width: 4, heightMode: "content", gap: 1 }, "scroll"),
      component("one", "2DMaterialComponent", { width: 2, height: 3, widthMode: "fixed", heightMode: "fixed" }, "column"),
      component("two", "2DMaterialComponent", { width: 2, height: 3, widthMode: "fixed", heightMode: "fixed" }, "column"),
    ]);
    const result = resolveOverlayLayout([root]);
    expect(result.entries.get("root/scroll")!.scroll).toMatchObject({ y: 3, maxY: 3 });
    expect(result.entries.get("root/two")!.rect).toEqual({ x: -1, y: -0.5, width: 2, height: 3 });
    expect(result.entries.get("root/one")!.clip).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(result.entries.get("root/two")!.scrollAncestors).toEqual([overlayLayoutKey("root", "scroll")]);
  });
  it("measures content boxes in child order and reflows when children become hidden", () => {
    const root = actor("root", [component("row", "2DHorizontalBoxComponent", { widthMode: "content", heightMode: "content", gap: 0.5 }), component("a", "2DMaterialComponent", {}, "row"), component("b", "2DMaterialComponent", { visible: false }, "row"), component("c", "2DMaterialComponent", {}, "row")]);
    const result = resolveOverlayLayout([root]);
    expect(result.entries.get("root/row")!.rect.width).toBe(2.5);
    expect(result.entries.get("root/a")!.rect.x).toBe(-0.75);
    expect(result.entries.get("root/c")!.rect.x).toBe(0.75);
  });
  it("uses authored texture pixels and text wrap sizes for desired dimensions", () => {
    const root = actor("root", [component("row", "2DHorizontalBoxComponent", { widthMode: "content", heightMode: "content" }), component("texture", "2DTextureComponent", { textureGuid: "image" }, "row"), component("text", "2DTextComponent", { wrapWidth: 200, wrapHeight: 50 }, "row")]);
    const result = resolveOverlayLayout([root], { pixelsPerUnit: 100, textureSize: () => ({ width: 300, height: 100 }) });
    expect(result.entries.get("root/row")!.rect).toMatchObject({ width: 5, height: 1 });
    expect(result.entries.get("root/text")!.rect).toMatchObject({ width: 2, height: 0.5 });
  });
  it("measures unwrapped text defaults and rich visible content instead of markup characters", () => {
    const root = actor("root", [
      component("row", "2DHorizontalBoxComponent", { widthMode: "content", heightMode: "content" }),
      component("default", "2DTextComponent", {}, "row"),
      component("rich", "2DRichTextComponent", { text: "[b]Hi[/b]\n[size=64]W[/size][img=icon size=16]" }, "row"),
    ]);
    const result = resolveOverlayLayout([root], { pixelsPerUnit: 100 });
    expect(result.entries.get("root/default")!.rect.width).toBeCloseTo(0.768);
    expect(result.entries.get("root/default")!.rect.height).toBeCloseTo(0.384);
    expect(result.entries.get("root/rich")!.rect.width).toBeCloseTo(0.544);
    expect(result.entries.get("root/rich")!.rect.height).toBeCloseTo(1.152);
    expect(result.entries.get("root/row")!.rect.width).toBeCloseTo(1.312);
  });
});

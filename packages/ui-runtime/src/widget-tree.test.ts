import { describe, expect, it } from "vitest";
import { createDefaultUserInterface, createWidget } from "./types";
import {
  duplicateWidget,
  insertWidget,
  removeWidget,
  reparentWidget,
  widgetParentId,
} from "./widget-tree";
import { defaultAddLayout } from "./layout-authoring";

describe("widget tree", () => {
  it("inserts a widget under the selected parent", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    const next = insertWidget(doc, button, doc.rootId);
    expect(next.widgets.btn?.kind).toBe("Button");
    expect(next.widgets[doc.rootId]?.children).toContain("btn");
  });

  it("refuses to delete the root canvas", () => {
    const doc = createDefaultUserInterface();
    const next = removeWidget(doc, doc.rootId);
    expect(next.widgets[doc.rootId]).toBeDefined();
    expect(Object.keys(next.widgets)).toHaveLength(1);
  });

  it("deletes a widget and its descendants", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("box", "VerticalBox", "Col");
    const child = createWidget("child", "Text", "Label");
    let next = insertWidget(doc, box, doc.rootId);
    next = insertWidget(next, child, "box");
    next = removeWidget(next, "box");
    expect(next.widgets.box).toBeUndefined();
    expect(next.widgets.child).toBeUndefined();
    expect(next.widgets[doc.rootId]?.children).not.toContain("box");
  });

  it("reparents without creating a cycle", () => {
    const doc = createDefaultUserInterface();
    const a = createWidget("a", "Border", "A");
    const b = createWidget("b", "Text", "B");
    let next = insertWidget(doc, a, doc.rootId);
    next = insertWidget(next, b, "a");
    expect(reparentWidget(next, "a", "b")).toBe(next);
    const moved = reparentWidget(next, "b", doc.rootId);
    expect(moved.widgets.a?.children).not.toContain("b");
    expect(moved.widgets[doc.rootId]?.children).toContain("b");
    expect(widgetParentId(moved, "b")).toBe(doc.rootId);
  });

  it("reorders siblings before or after an anchor without nesting", () => {
    const doc = createDefaultUserInterface();
    const a = createWidget("a", "Button", "A");
    const b = createWidget("b", "Button", "B");
    const c = createWidget("c", "Button", "C");
    let next = insertWidget(doc, a, doc.rootId);
    next = insertWidget(next, b, doc.rootId);
    next = insertWidget(next, c, doc.rootId);
    expect(next.widgets[doc.rootId]?.children).toEqual(["a", "b", "c"]);

    next = reparentWidget(next, "c", "a", "before");
    expect(next.widgets[doc.rootId]?.children).toEqual(["c", "a", "b"]);
    expect(widgetParentId(next, "c")).toBe(doc.rootId);

    next = reparentWidget(next, "c", "a", "after");
    expect(next.widgets[doc.rootId]?.children).toEqual(["a", "c", "b"]);
    expect(widgetParentId(next, "c")).toBe(doc.rootId);
  });

  it("nests into a target row and still rejects cycles", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("box", "VerticalBox", "Col");
    const a = createWidget("a", "Button", "A");
    const b = createWidget("b", "Button", "B");
    let next = insertWidget(doc, box, doc.rootId);
    next = insertWidget(next, a, doc.rootId);
    next = insertWidget(next, b, "box");
    next = reparentWidget(next, "a", "box", "into");
    expect(next.widgets.box?.children).toEqual(["b", "a"]);
    expect(next.widgets[doc.rootId]?.children).toEqual(["box"]);
    expect(reparentWidget(next, "box", "a", "into")).toBe(next);
    expect(reparentWidget(next, "box", "a", "before")).toBe(next);
  });

  it("duplicates a widget as a sibling with a new id", () => {
    const doc = createDefaultUserInterface();
    const button = createWidget("btn", "Button", "Play", defaultAddLayout("Button"));
    let next = insertWidget(doc, button, doc.rootId);
    next = duplicateWidget(next, "btn", "btn-copy");
    expect(next.widgets["btn-copy"]?.name).toBe("Play Copy");
    expect(next.widgets["btn-copy"]?.kind).toBe("Button");
    expect(next.widgets[doc.rootId]?.children).toEqual(["btn", "btn-copy"]);
  });

  it("duplicates a container and its descendants", () => {
    const doc = createDefaultUserInterface();
    const box = createWidget("box", "VerticalBox", "Col");
    const child = createWidget("child", "Text", "Label");
    let next = insertWidget(doc, box, doc.rootId);
    next = insertWidget(next, child, "box");
    next = duplicateWidget(next, "box", "box-copy");
    expect(next.widgets["box-copy"]?.children.length).toBe(1);
    const copiedChildId = next.widgets["box-copy"]?.children[0];
    expect(copiedChildId).toBeTruthy();
    expect(next.widgets[copiedChildId!]?.kind).toBe("Text");
    expect(next.widgets.child).toBeDefined();
  });
});

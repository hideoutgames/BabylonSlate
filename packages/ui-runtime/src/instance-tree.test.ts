import { describe, expect, it } from "vitest";
import {
  createDefaultUserInterface,
  createWidget,
  pinLayout,
} from "./types";
import {
  applyUiTreeAddWidget,
  applyUiTreePatchLayout,
  applyUiTreeRemoveWidget,
  applyUiTreeReparentWidget,
  cloneUserInterfaceDocument,
  userInterfaceDocumentFromMeta,
} from "./instance-tree";

describe("instance widget tree", () => {
  it("clones widgets so later layout patches do not mutate the seed", () => {
    const seed = createDefaultUserInterface("HUD");
    const button = createWidget(
      "play-btn",
      "Button",
      "Play",
      pinLayout("center", "center", 160, 40),
    );
    seed.widgets[button.id] = button;
    seed.widgets[seed.rootId]!.children.push(button.id);
    const clone = cloneUserInterfaceDocument(seed);
    clone.widgets["play-btn"]!.layout.left = 40;
    expect(seed.widgets["play-btn"]?.layout.left).toBe(0);
  });

  it("rebuilds a Canvas tree from slim widget metadata", () => {
    const doc = userInterfaceDocumentFromMeta("HUD", [
      { id: "root", kind: "Canvas", name: "Canvas" },
      { id: "play-btn", kind: "Button", name: "Play" },
      { id: "logo", kind: "Image", name: "Logo" },
    ]);
    expect(doc.rootId).toBe("root");
    expect(doc.widgets.root?.kind).toBe("Canvas");
    expect(doc.widgets["play-btn"]?.name).toBe("Play");
    expect(doc.widgets.root?.children).toEqual(["play-btn", "logo"]);
  });

  it("adds a named widget under a parent and patches layout", () => {
    const seed = userInterfaceDocumentFromMeta("HUD", [
      { id: "root", kind: "Canvas", name: "Canvas" },
    ]);
    const added = applyUiTreeAddWidget(seed, {
      widgetId: "score",
      kind: "TextBlock",
      name: "Score",
      parentId: "root",
    });
    expect(added.widgets.score?.kind).toBe("TextBlock");
    expect(added.widgets.root?.children).toContain("score");
    const patched = applyUiTreePatchLayout(added, "score", {
      left: 12,
      top: 24,
      width: 80,
      height: 32,
      rotation: 15,
      scaleX: 2,
      horizontalAlignment: "right",
      verticalAlignment: "bottom",
    });
    expect(patched.widgets.score?.layout).toMatchObject({
      left: 12,
      top: 24,
      width: 80,
      height: 32,
      rotation: 15,
      scaleX: 2,
      horizontalAlignment: "right",
      verticalAlignment: "bottom",
    });
  });

  it("reparents at a sibling index and refuses to remove the Canvas root", () => {
    let doc = userInterfaceDocumentFromMeta("HUD", [
      { id: "root", kind: "Canvas", name: "Canvas" },
    ]);
    doc = applyUiTreeAddWidget(doc, {
      widgetId: "a",
      kind: "Button",
      name: "A",
      parentId: "root",
    });
    doc = applyUiTreeAddWidget(doc, {
      widgetId: "b",
      kind: "Button",
      name: "B",
      parentId: "root",
    });
    doc = applyUiTreeAddWidget(doc, {
      widgetId: "box",
      kind: "StackPanel",
      name: "Box",
      parentId: "root",
    });
    const moved = applyUiTreeReparentWidget(doc, {
      widgetId: "a",
      parentId: "box",
      siblingIndex: 0,
    });
    expect(moved.widgets.box?.children).toEqual(["a"]);
    expect(moved.widgets.root?.children).toEqual(["b", "box"]);
    const rooted = applyUiTreeReparentWidget(moved, {
      widgetId: "root",
      parentId: "box",
    });
    expect(rooted).toBe(moved);
    const kept = applyUiTreeRemoveWidget(moved, "root");
    expect(kept.widgets.root).toBeDefined();
    const removed = applyUiTreeRemoveWidget(moved, "box");
    expect(removed.widgets.box).toBeUndefined();
    expect(removed.widgets.a).toBeUndefined();
  });
});

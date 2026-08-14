import { describe, expect, it } from "vitest";
import { Color4 } from "@babylonjs/core";
import {
  applyEditorClearColor,
  documentEditorColorScheme,
  editorClearColor,
  EDITOR_CANVAS_COLOR_SCHEME,
  sceneClearColor,
} from "./editor-clear-color";

describe("editorClearColor", () => {
  it("returns white for the light Neutral canvas", () => {
    const color = editorClearColor("light");
    expect(color.r).toBe(1);
    expect(color.g).toBe(1);
    expect(color.b).toBe(1);
    expect(color.a).toBe(1);
  });

  it("returns Neutral ink for the dark canvas (oklch(0.145 0 0) ≈ #242424)", () => {
    const color = editorClearColor("dark");
    expect(color.r).toBeCloseTo(36 / 255);
    expect(color.g).toBeCloseTo(36 / 255);
    expect(color.b).toBeCloseTo(36 / 255);
    expect(color.a).toBe(1);
  });

  it("assigns the scheme onto an existing scene clearColor", () => {
    const scene = { clearColor: new Color4(0, 0, 0, 1) };
    applyEditorClearColor(scene, "light");
    expect(scene.clearColor.r).toBe(1);
    applyEditorClearColor(scene, "dark");
    expect(scene.clearColor.r).toBeCloseTo(36 / 255);
  });

  it("defaults to dark when no document is present", () => {
    expect(documentEditorColorScheme()).toBe("dark");
  });

  it("locks editor canvases to the dark scheme", () => {
    expect(EDITOR_CANVAS_COLOR_SCHEME).toBe("dark");
  });

  it("builds an opaque Color4 from scene environmentColor", () => {
    const color = sceneClearColor([0.1, 0.2, 0.3]);
    expect(color.r).toBeCloseTo(0.1);
    expect(color.g).toBeCloseTo(0.2);
    expect(color.b).toBeCloseTo(0.3);
    expect(color.a).toBe(1);
  });
});

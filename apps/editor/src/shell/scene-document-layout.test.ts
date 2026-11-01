import { describe, expect, it } from "vitest";
import { parseSceneDocumentLayout } from "./scene-document-layout";
import { listDockWindows } from "./window-catalog";
import { applyFocusLayout, focusKeepPanelIds } from "./layout-ops";
import { engineSettingsSchema } from "@haptic/vfs";

describe("Scene mode layouts", () => {
  it("round-trips independent per-mode layouts", () => {
    const design = { panels: { viewport: { id: "viewport" }, custom: { id: "custom" } } };
    const landscape = { panels: { viewport: { id: "viewport" }, "landscape-settings": { id: "landscape-settings" } } };
    const script = { panels: { graph: { id: "graph" } } };
    const timeline = { panels: { "scene-timeline": { id: "scene-timeline" } } };
    const saved = JSON.parse(JSON.stringify({ sceneMode: "foliage", design, landscape, foliage: null, script, timeline }));
    expect(parseSceneDocumentLayout(saved)).toEqual({ sceneMode: "foliage", design, landscape, foliage: null, script, timeline });
  });
  it("offers a Scene Layer only Design, Script and Timeline, keeping a layout saved before it had modes", () => {
    expect(parseSceneDocumentLayout({ sceneMode: "landscape" }, "scene-layer").sceneMode).toBe("design");
    expect(parseSceneDocumentLayout({ sceneMode: "script" }, "scene-layer").sceneMode).toBe("script");
    expect(parseSceneDocumentLayout({ sceneMode: "timeline" }, "scene-layer").sceneMode).toBe("timeline");
    const flat = { grid: { root: {} }, panels: { viewport: { id: "viewport" } } };
    expect(parseSceneDocumentLayout(flat, "scene-layer")).toMatchObject({ sceneMode: "design", design: flat, script: null });
  });
  it("lays Script mode out like an Object Class, without the viewport or Prefab", () => {
    for (const kind of ["scene", "scene-layer"] as const) {
      const ids = listDockWindows(kind, { sceneMode: "script" }).map((entry) => entry.id);
      expect(ids).toEqual(["graph", "my-class", "inspector", "compiler-results"]);
    }
  });
  it("lays Timeline mode out with the Outliner and Clips beside the Viewport and the Timeline below it", () => {
    for (const kind of ["scene", "scene-layer"] as const) {
      const windows = listDockWindows(kind, { sceneMode: "timeline" });
      expect(windows.filter((entry) => entry.openByDefault !== false).map((entry) => [entry.id, entry.defaultPosition?.referencePanelId ?? null,
        entry.defaultPosition?.direction ?? null])).toEqual([
        ["viewport", null, null],
        ["scene-outliner", "viewport", "left"],
        ["timeline-clips", "scene-outliner", "below"],
        ["scene-details", "viewport", "right"],
        ["scene-timeline", "viewport", "below"],
      ]);
      // Output Log and Compiler Results open from Windows, tabbed with the Timeline.
      expect(windows.filter((entry) => entry.openByDefault === false && entry.id !== "breakpoints").map((entry) => [entry.id, entry.defaultPosition?.referencePanelId]))
        .toEqual([["output-log", "scene-timeline"], ["compiler-results", "scene-timeline"]]);
    }
    // Focus keeps the Viewport and the Timeline by default.
    const settings = engineSettingsSchema.parse({});
    expect(focusKeepPanelIds(settings, "scene", { sceneMode: "timeline" })).toEqual(["viewport", "scene-timeline"]);
    expect(focusKeepPanelIds(settings, "scene-layer", { sceneMode: "timeline" })).toEqual(["viewport", "scene-timeline"]);
  });
  it("uses each mode's window catalog and Focus keep-list", () => {
    const settings = engineSettingsSchema.parse({ focusKeepPanels: { scene: ["viewport", "scene-details"], sceneLandscape: ["viewport", "landscape-settings"], sceneFoliage: ["viewport", "foliage-groups"] } });
    for (const sceneMode of ["landscape", "foliage"] as const) {
      const open = new Set(listDockWindows("scene", { sceneMode }).map((entry) => entry.id));
      expect(open.has("scene-details")).toBe(false);
      applyFocusLayout("scene", { panels: [...open].map((id) => ({ id })), getPanel: (id) => ({ api: { close: () => { open.delete(id); } } }) }, focusKeepPanelIds(settings, "scene", { sceneMode }), { sceneMode });
      expect([...open]).toEqual(sceneMode === "landscape" ? ["viewport", "landscape-settings"] : ["viewport", "foliage-groups"]);
    }
    expect(listDockWindows("scene-layer", { sceneMode: "foliage" }).some((entry) => entry.id === "scene-outliner")).toBe(true);
  });
});

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
    const saved = JSON.parse(JSON.stringify({ sceneMode: "foliage", design, landscape, foliage: null, script }));
    expect(parseSceneDocumentLayout(saved)).toEqual({ sceneMode: "foliage", design, landscape, foliage: null, script });
  });
  it("offers a Scene Layer only Design and Script, keeping a layout saved before it had modes", () => {
    expect(parseSceneDocumentLayout({ sceneMode: "landscape" }, "scene-layer").sceneMode).toBe("design");
    expect(parseSceneDocumentLayout({ sceneMode: "script" }, "scene-layer").sceneMode).toBe("script");
    const flat = { grid: { root: {} }, panels: { viewport: { id: "viewport" } } };
    expect(parseSceneDocumentLayout(flat, "scene-layer")).toMatchObject({ sceneMode: "design", design: flat, script: null });
  });
  it("lays Script mode out like an Object Class, without the viewport or Prefab", () => {
    for (const kind of ["scene", "scene-layer"] as const) {
      const ids = listDockWindows(kind, { sceneMode: "script" }).map((entry) => entry.id);
      expect(ids).toEqual(["graph", "my-class", "inspector", "compiler-results"]);
    }
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

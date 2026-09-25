import { describe, expect, it } from "vitest";
import { parseSceneDocumentLayout } from "./scene-document-layout";
import { listDockWindows } from "./window-catalog";
import { applyFocusLayout, focusKeepPanelIds } from "./layout-ops";
import { engineSettingsSchema } from "@babylonslate/vfs";

describe("Scene mode layouts", () => {
  it("migrates an existing scene arrangement to Design and round-trips independent layouts", () => {
    const design = { panels: { viewport: { id: "viewport" }, custom: { id: "custom" } } };
    const migrated = parseSceneDocumentLayout(design);
    expect(migrated.design).toBe(design);
    const landscape = { panels: { viewport: { id: "viewport" }, "landscape-settings": { id: "landscape-settings" } } };
    const saved = JSON.parse(JSON.stringify({ ...migrated, sceneMode: "foliage", landscape }));
    expect(parseSceneDocumentLayout(saved)).toEqual({ sceneMode: "foliage", design, landscape, foliage: null });
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

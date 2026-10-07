// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountPlayerHud } from "./hud";

describe("Player console HUD commands", () => {
  it("keeps sampled stats while hidden and adds rows for enabled stat groups", () => {
    const element = document.createElement("div");
    const hud = mountPlayerHud(element, { bundleDebugger: true });
    expect(hud.applyCommand({ type: "setShowFps", enabled: false })).toBe(true);
    expect(element.hidden).toBe(true);
    hud.setStats({ ticks: 12, fps: 60, scriptMs: 2, physicsMs: 1, draws: 18, geometryBytes: 1048576 });
    expect(element.hidden).toBe(true);
    expect(element.querySelector('[data-stat="memory"]')).toBeNull();
    expect(hud.applyCommand({ type: "setStat", name: "memory", enabled: true })).toBe(true);
    expect(element.hidden).toBe(false);
    expect(element.dataset.groups).toBe("memory");
    expect(element.querySelector('[data-stat="memory"]')?.textContent).toContain("1.0 MB");
    expect(element.textContent).toContain("60");
    hud.applyCommand({ type: "setStat", name: "unit", enabled: true });
    expect(element.dataset.groups).toBe("unit memory");
    hud.applyCommand({ type: "setStat", name: "memory", enabled: false });
    expect(element.dataset.groups).toBe("unit");
    expect(element.querySelector('[data-stat="memory"]')).toBeNull();
    expect(hud.applyCommand({ type: "setWireframe", enabled: true })).toBe(false);
  });

  it("starts hidden when the host owns the Stats toggle", () => {
    const element = document.createElement("div");
    mountPlayerHud(element, { bundleDebugger: true, visible: false });
    expect(element.hidden).toBe(true);
  });

  it("does not expose the stats HUD in a build without the debugger", () => {
    const element = document.createElement("div");
    const hud = mountPlayerHud(element, { bundleDebugger: false });
    hud.applyCommand({ type: "setShowFps", enabled: true });
    hud.applyCommand({ type: "setStat", name: "unit", enabled: true });
    hud.setStats({ ticks: 1, fps: 60, scriptMs: 1, physicsMs: 1, draws: 1 });
    expect(element.hidden).toBe(true);
    expect(element.textContent).toBe("");
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountPlayerHud } from "./hud";

describe("Player console HUD commands", () => {
  it("keeps sampled stats while hidden and highlights the requested measurement", () => {
    const element = document.createElement("div");
    const hud = mountPlayerHud(element, { bundleDebugger: true });
    expect(hud.applyCommand({ type: "setShowFps", enabled: false })).toBe(true);
    expect(element.hidden).toBe(true);
    hud.setStats({ ticks: 12, fps: 60, scriptMs: 2, physicsMs: 1, draws: 18, geometryBytes: 1048576 });
    expect(element.hidden).toBe(true);
    expect(hud.applyCommand({ type: "setStat", name: "memory", enabled: true })).toBe(true);
    expect(element.hidden).toBe(false);
    expect(element.dataset.highlight).toBe("memory");
    expect(element.querySelector('[data-stat="memory"]')?.textContent).toContain("1.0MB");
    expect(element.querySelector('[data-stat="memory"]')?.getAttribute("data-highlighted")).toBe("true");
    expect(element.textContent).toContain("60");
    hud.applyCommand({ type: "setStat", name: "threads", enabled: true });
    expect(element.querySelector('[data-stat="threads"]')?.getAttribute("data-highlighted")).toBe("true");
    expect(element.querySelector('[data-stat="unit"]')?.getAttribute("data-highlighted")).toBe("true");
    hud.applyCommand({ type: "setStat", name: "threads", enabled: false });
    expect(element.dataset.highlight).toBe("");
    expect(element.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
    expect(hud.applyCommand({ type: "setWireframe", enabled: true })).toBe(false);
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

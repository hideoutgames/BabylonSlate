// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mountPlayerDebuggerOverlays } from "./hud";

describe("mountPlayerDebuggerOverlays", () => {
  it("shows the occlusion overlay's caption while showocclusion is on, its canvas only while culling, and removes it when off", () => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    // jsdom has no 2D context; the overlay draws nothing then, and its caption still shows.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let overlay: ReturnType<NonNullable<Parameters<typeof mountPlayerDebuggerOverlays>[1]["occlusionOverlay"]>> = {
      buffer: { width: 2, height: 1, depth: new Float32Array([4, Infinity]) }, text: "occlusion culled 3/9 · 1 occluders",
    };
    const parent = document.createElement("div");
    const stop = mountPlayerDebuggerOverlays(parent, { bundleDebugger: true, occlusionOverlay: () => overlay });
    const element = () => parent.querySelector<HTMLElement>("[data-testid=occlusion-debug-overlay]");
    frame!(0);
    expect(element()?.textContent).toBe("occlusion culled 3/9 · 1 occluders");
    expect(element()?.querySelector("canvas")?.style.display).toBe("block");
    overlay = { buffer: null, text: "occlusion culling off" };
    frame!(0);
    expect(element()?.textContent).toBe("occlusion culling off");
    expect(element()?.querySelector("canvas")?.style.display).toBe("none");
    overlay = null;
    frame!(0);
    expect(element()).toBeNull();
    stop();
    vi.restoreAllMocks();
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { applyPlayerLayout } from "./layout";

describe("applyPlayerLayout", () => {
  it("letterboxes a custom framebuffer", () => {
    const root = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    } as unknown as HTMLElement;
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    const size = applyPlayerLayout({
      root,
      canvas,
      render: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        customResolution: true,
        width: 1920,
        height: 1080,
        blackBars: true,
      },
    });
    expect(size).toEqual({ width: 1920, height: 1080 });
    expect(canvas.style.width).toBe("1600px");
    expect(canvas.style.height).toBe("900px");
    expect(root.style.background).toBe("#000");
  });
});

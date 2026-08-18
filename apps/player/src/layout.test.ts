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

  it("letterboxes a locked framebuffer even when black bars are off", () => {
    const root = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    } as unknown as HTMLElement;
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    applyPlayerLayout({
      root,
      canvas,
      render: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        customResolution: true,
        width: 1920,
        height: 1080,
        blackBars: false,
      },
    });
    expect(canvas.style.width).toBe("1600px");
    expect(canvas.style.height).toBe("900px");
    expect(canvas.style.objectFit).not.toBe("fill");
    expect(root.style.background).toBe("#000");
  });

  it("recomputes the letterbox when the host size changes", () => {
    const root = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    } as unknown as HTMLElement;
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    const render = {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      customResolution: true,
      width: 1920,
      height: 1080,
      blackBars: false,
    };
    applyPlayerLayout({ root, canvas, render });
    root.clientWidth = 1920;
    root.clientHeight = 1080;
    applyPlayerLayout({ root, canvas, render });
    expect(canvas.style.width).toBe("1920px");
    expect(canvas.style.height).toBe("1080px");
  });
});

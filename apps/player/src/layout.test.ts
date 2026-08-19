import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { applyPlayerLayout } from "./layout";

type LayoutRoot = {
  clientWidth: number;
  clientHeight: number;
  style: { background: string };
};

function asRoot(root: LayoutRoot): HTMLElement {
  return root as unknown as HTMLElement;
}

describe("applyPlayerLayout", () => {
  it("letterboxes a custom framebuffer", () => {
    const root: LayoutRoot = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    };
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    const size = applyPlayerLayout({
      root: asRoot(root),
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

  it("fills the host without stretching when black bars are off", () => {
    const root: LayoutRoot = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    };
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    const size = applyPlayerLayout({
      root: asRoot(root),
      canvas,
      render: {
        ...DEFAULT_RENDER_PROJECT_SETTINGS,
        customResolution: true,
        width: 1920,
        height: 1080,
        blackBars: false,
      },
    });
    expect(size).toBeNull();
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
    expect(canvas.style.objectFit).not.toBe("fill");
    expect(root.style.background).toBe("#111");
  });

  it("recomputes the letterbox when the host size changes", () => {
    const root: LayoutRoot = {
      clientWidth: 1600,
      clientHeight: 1200,
      style: { background: "" },
    };
    const canvas = { style: { width: "", height: "", objectFit: "" } } as HTMLCanvasElement;
    const render = {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      customResolution: true,
      width: 1920,
      height: 1080,
      blackBars: true,
    };
    applyPlayerLayout({ root: asRoot(root), canvas, render });
    root.clientWidth = 1920;
    root.clientHeight = 1080;
    applyPlayerLayout({ root: asRoot(root), canvas, render });
    expect(canvas.style.width).toBe("1920px");
    expect(canvas.style.height).toBe("1080px");
  });
});

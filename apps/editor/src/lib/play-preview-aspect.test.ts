import { afterEach, describe, expect, it } from "vitest";
import {
  applyPlayPreviewCanvasLayout,
  fitContainedRect,
} from "./play-preview-aspect";

afterEach(() => {
  document.body.replaceChildren();
});

function stubClientSize(
  element: HTMLElement,
  width: number,
  height: number,
): void {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: height,
  });
}

describe("fitContainedRect", () => {
  it("fills a matching 16:9 container", () => {
    expect(fitContainedRect(1920, 1080, 16, 9)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("letterboxes 16:9 inside a 4:3 window", () => {
    expect(fitContainedRect(1600, 1200, 16, 9)).toEqual({
      width: 1600,
      height: 900,
    });
  });

  it("pillarboxes 9:16 inside a landscape window", () => {
    expect(fitContainedRect(1920, 1080, 9, 16)).toEqual({
      width: 608,
      height: 1080,
    });
  });

  it("returns zero when the container has no size", () => {
    expect(fitContainedRect(0, 1080, 16, 9)).toEqual({ width: 0, height: 0 });
  });
});

describe("applyPlayPreviewCanvasLayout", () => {
  it("fills the overlay and uses the background when following the system", () => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 flex flex-col bg-black";
    const canvas = document.createElement("canvas");
    canvas.style.width = "100px";
    canvas.style.height = "50px";
    overlay.append(canvas);
    document.body.append(overlay);
    stubClientSize(overlay, 1920, 1080);

    applyPlayPreviewCanvasLayout({
      overlay,
      canvas,
      followSystem: true,
      aspectWidth: 16,
      aspectHeight: 9,
    });

    expect(canvas.style.width).toBe("");
    expect(canvas.style.height).toBe("");
    expect(canvas.classList.contains("h-full")).toBe(true);
    expect(canvas.classList.contains("w-full")).toBe(true);
    expect(overlay.classList.contains("bg-background")).toBe(true);
    expect(overlay.classList.contains("bg-black")).toBe(false);
    expect(overlay.classList.contains("items-center")).toBe(false);
    expect(overlay.classList.contains("justify-center")).toBe(false);
  });

  it("sizes the canvas to 16:9 and paints black bars when forced", () => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 flex flex-col bg-background";
    const canvas = document.createElement("canvas");
    canvas.className = "h-full w-full touch-none";
    overlay.append(canvas);
    document.body.append(overlay);
    stubClientSize(overlay, 1600, 1200);

    applyPlayPreviewCanvasLayout({
      overlay,
      canvas,
      followSystem: false,
      aspectWidth: 16,
      aspectHeight: 9,
    });

    expect(canvas.style.width).toBe("1600px");
    expect(canvas.style.height).toBe("900px");
    expect(canvas.classList.contains("h-full")).toBe(false);
    expect(canvas.classList.contains("w-full")).toBe(false);
    expect(overlay.classList.contains("bg-black")).toBe(true);
    expect(overlay.classList.contains("bg-background")).toBe(false);
    expect(overlay.classList.contains("items-center")).toBe(true);
    expect(overlay.classList.contains("justify-center")).toBe(true);
  });
});

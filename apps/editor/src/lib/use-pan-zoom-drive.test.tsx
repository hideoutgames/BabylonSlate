import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePanZoomSurface, type PanZoomLimits, type PanZoomSurface } from "@haptic/editor-kit";
import type { ViewportZoomDrive } from "@haptic/render";
import { usePanZoomDrive } from "./use-pan-zoom-drive";

let surface: PanZoomSurface | null = null;
let drive: () => ViewportZoomDrive | null = () => null;

function Host({ limits }: { limits?: PanZoomLimits }) {
  const panZoom = usePanZoomSurface({ content: { width: 100, height: 100 }, base: "actual", limits });
  surface = panZoom;
  drive = usePanZoomDrive(panZoom);
  return <div ref={panZoom.surfaceRef} />;
}

describe("usePanZoomDrive", () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    // A 200 x 100 surface: its centre is (100, 50), and 100 x 100 content at 1:1 rests at (50, 0).
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-reduced-motion");
  });

  it("zooms one step by 1.2 about the surface centre, as an adjusted view", () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    render(<Host />);
    expect(surface?.view).toEqual({ scale: 1, x: 50, y: 0 });
    act(() => drive()?.step(1));
    expect(surface?.view?.scale).toBeCloseTo(1.2);
    expect(surface?.view?.x).toBeCloseTo(40);
    expect(surface?.view?.y).toBeCloseTo(-10);
    expect(surface?.adjusted).toBe(true);
  });

  it("ends a held press at the surface's maximum scale", () => {
    render(<Host limits={{ minScale: 0.5, maxScale: 1.5 }} />);
    act(() => drive()?.start(1));
    const startedAt = performance.now();
    for (let frame = 1; frame <= 40 && frames.length > 0; frame += 1) {
      const next = frames.shift()!;
      act(() => next(startedAt + frame * 50));
    }
    expect(surface?.view?.scale).toBe(1.5);
    // The press ended at the limit by itself: no frame is pending although the button is still held.
    expect(frames).toHaveLength(0);
  });
});

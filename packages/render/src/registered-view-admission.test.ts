import { NullEngine } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { admitRegisteredViewFrames, registeredViewIsEnabled, retainOffscreenFrameDispatch, setRegisteredViewEnabled } from "./registered-view-admission";

class PixelCanvas {
  private bitmapWidth = 32;
  private bitmapHeight = 32;
  clientWidth = 32;
  clientHeight = 32;
  pixel = 0;
  get width() { return this.bitmapWidth; }
  set width(value: number) { this.bitmapWidth = value; this.pixel = 0; }
  get height() { return this.bitmapHeight; }
  set height(value: number) { this.bitmapHeight = value; this.pixel = 0; }
  getContext() { return { clearRect: () => { this.pixel = 0; }, drawImage: (source: PixelCanvas) => { this.pixel = source.pixel; } }; }
}

describe("registered view frame admission", () => {
  it("retains offscreen dispatch until its last client leaves without replacing another owner's hook", () => {
    const engine = new NullEngine();
    const canvas = new PixelCanvas();
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const view = engine.registerView(canvas as unknown as HTMLCanvasElement);
    view.enabled = false;
    const original = engine._renderViews;
    const first = retainOffscreenFrameDispatch(engine);
    const second = retainOffscreenFrameDispatch(engine);
    try {
      first();
      first();
      expect(engine._renderViews()).toBe(false);
      second();
      expect(engine._renderViews).toBe(original);
      expect(engine._renderViews()).toBe(true);
      const release = retainOffscreenFrameDispatch(engine);
      const replacement = () => false;
      engine._renderViews = replacement;
      release();
      expect(engine._renderViews).toBe(replacement);
    } finally { first(); second(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("preserves the last presented canvas when native resize/copy would run on a skipped frame", () => {
    const engine = new NullEngine();
    const source = new PixelCanvas();
    const target = new PixelCanvas();
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(source as unknown as HTMLCanvasElement);
    vi.spyOn(engine, "setSize").mockImplementation((width, height) => { source.width = width; source.height = height; return true; });
    const view = engine.registerView(target as unknown as HTMLCanvasElement, undefined, true);
    let admitted = true;
    let color = 0xff8040;
    const release = admitRegisteredViewFrames(engine, view, () => admitted);
    engine.runRenderLoop(() => { if (admitted) source.pixel = color; });
    const frame = () => { engine.beginFrame(); engine._renderViews(); engine.endFrame(); };
    try {
      frame();
      expect(target.pixel).toBe(0xff8040);
      admitted = false;
      target.clientWidth = 64;
      frame();
      expect(target.pixel).toBe(0xff8040);
      expect(target.width).toBe(32);
      admitted = true;
      color = 0x40a0ff;
      frame();
      expect(target.pixel).toBe(0x40a0ff);
      expect(target.width).toBe(64);
    } finally { release(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("preserves a disable request made during an admitted-frame hold and releases its observers", () => {
    const engine = new NullEngine();
    const canvas = new PixelCanvas();
    vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const view = engine.registerView(canvas as unknown as HTMLCanvasElement);
    const release = admitRegisteredViewFrames(engine, view, () => false);
    try {
      engine.beginFrame();
      expect(registeredViewIsEnabled(view)).toBe(true);
      setRegisteredViewEnabled(view, false);
      engine.endFrame();
      expect(view.enabled).toBe(false);
      release();
      setRegisteredViewEnabled(view, true);
      engine.beginFrame();
      expect(view.enabled).toBe(true);
      engine.endFrame();
    } finally { release(); engine.dispose(); vi.restoreAllMocks(); }
  });
});

import { NullEngine, type EngineView } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDirectViewPresentationEnabled, syncDirectViewCanvas, type HeldImageStore } from "./direct-view-presentation";
import { admitRegisteredViewFrames, setHeldImageStoreFactoryForTests, setRegisteredViewEnabled } from "./registered-view-admission";

const mainDocument = {};

let panels = 0;

/** Minimal DOM: parents keep ordered children; a canvas holds one "pixel" that a resize clears. */
class FakeParent {
  children: FakeCanvas[] = [];
  /** Distinct per parent, so structural matchers cannot mistake one parent for another. */
  constructor(readonly name = `panel-${++panels}`) {}
  isConnected = true;
  insertBefore(node: FakeCanvas, before: FakeCanvas | null) {
    node.parentNode?.removeChild(node);
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: FakeCanvas) {
    this.children.splice(this.children.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
}

class FakeCanvas {
  parentNode: FakeParent | null = null;
  ownerDocument: object = mainDocument;
  attributes = new Map<string, string>();
  style: Record<string, string> & { cssText: string } = { cssText: "display: none" };
  clientWidth = 32;
  clientHeight = 32;
  pixel = 0;
  rect = { left: 10, top: 20, width: 32, height: 32 };
  private bitmap = { width: 32, height: 32 };
  get isConnected() { return this.parentNode?.isConnected ?? false; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get nextSibling() { const list = this.parentNode?.children ?? []; return list[list.indexOf(this) + 1] ?? null; }
  get previousSibling() { const list = this.parentNode?.children ?? []; return list[list.indexOf(this) - 1] ?? null; }
  get width() { return this.bitmap.width; }
  set width(value: number) { this.bitmap.width = value; this.pixel = 0; }
  get height() { return this.bitmap.height; }
  set height(value: number) { this.bitmap.height = value; this.pixel = 0; }
  getBoundingClientRect() {
    // A placed Engine canvas sits where its style puts it; a view canvas where layout put it.
    if (this.style.position !== "absolute") return this.rect;
    return { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0, width: parseFloat(this.style.width) || 0, height: parseFloat(this.style.height) || 0 };
  }
  getContext() {
    return { clearRect: () => { this.pixel = 0; }, drawImage: (source: FakeCanvas) => { this.pixel = source.pixel; } };
  }
}

/**
 * Held images are the Engine canvas pixel at snapshot time, per view. While
 * `off()` the store can neither hold nor restore (it turned itself off).
 */
function useFakeHeldImages({ off, ...extra }: Pick<HeldImageStore, "engage" | "usable"> & { off?: () => boolean } = {}) {
  const blits = { count: 0 };
  setHeldImageStoreFactoryForTests((engine) => {
    const source = engine.getRenderingCanvas() as unknown as FakeCanvas;
    const held = new Map<EngineView, { pixel: number; width: number; height: number }>();
    const store: HeldImageStore = {
      ...extra,
      snapshot: (view, width, height) => {
        if (off?.()) return false;
        blits.count++;
        held.set(view, { pixel: source.pixel, width, height });
        return true;
      },
      restore: (view) => {
        const entry = held.get(view);
        if (!entry || off?.()) return false;
        blits.count++;
        source.pixel = entry.pixel;
        return true;
      },
      size: (view) => { const entry = held.get(view); return entry ? { width: entry.width, height: entry.height } : null; },
      release: (view) => { held.delete(view); },
      clear: () => { held.clear(); },
    };
    return store;
  });
  return blits;
}

/** One Engine on a body-parented canvas; its loop paints `color` and the frame is coherent or not, or idles without drawing. */
function host() {
  const engine = new NullEngine();
  const body = new FakeParent("body");
  const source = new FakeCanvas();
  body.insertBefore(source, null);
  vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(source as unknown as HTMLCanvasElement);
  vi.spyOn(engine, "setSize").mockImplementation((width, height) => {
    const changed = source.width !== width || source.height !== height;
    source.width = width;
    source.height = height;
    return changed;
  });
  const state = { color: 0, coherent: true, idle: false, drew: false, during: null as (() => void) | null };
  engine.runRenderLoop(() => {
    if (state.idle) return;
    state.drew = true;
    source.pixel = state.color;
    state.during?.();
  });
  const frame = () => {
    engine.beginFrame();
    engine._renderViews();
    engine.endFrame();
  };
  const draw = (color: number, coherent = true, during: (() => void) | null = null) => {
    Object.assign(state, { color, coherent, idle: false, during });
    frame();
  };
  /** A frame whose loop declines to draw (render on demand with nothing new). */
  const idle = () => {
    Object.assign(state, { coherent: false, idle: true, during: null });
    frame();
  };
  /** A view canvas in its own panel, admitted while it has a layout box (a hidden dock tab has none). */
  const view = (target = new FakeCanvas(), options: { allowDirect?: () => boolean } = {}) => {
    const panel = target.parentNode ?? new FakeParent();
    if (!target.parentNode) panel.insertBefore(target, null);
    const registered = engine.registerView(target as unknown as HTMLCanvasElement, undefined, true);
    let copies = 0;
    const release = admitRegisteredViewFrames(engine, registered, () => target.clientWidth > 0, {
      begin: () => { state.drew = false; }, canCopy: () => state.coherent, dirty: () => state.drew, allowDirect: options.allowDirect, copied: () => { copies++; },
    });
    return { panel, target, view: registered, release, copies: () => copies };
  };
  return { engine, body, source, draw, idle, view };
}

afterEach(() => {
  setHeldImageStoreFactoryForTests(null);
  setDirectViewPresentationEnabled(true);
  vi.restoreAllMocks();
});

describe("direct view presentation", () => {
  it("shows the Engine canvas over a sole view and copies while several views are enabled", () => {
    useFakeHeldImages();
    const { engine, body, source, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      expect(source.parentNode).toBe(a.panel);
      expect(source.previousSibling).toBe(a.target);
      expect([source.style.visibility, source.style.pointerEvents, source.getAttribute("aria-hidden")]).toEqual(["visible", "none", "true"]);
      expect([source.style.left, source.style.top, source.style.width, source.style.height]).toEqual(["10px", "20px", "32px", "32px"]);
      // Nothing was copied into the view canvas, which still reports the presented size.
      expect([a.target.pixel, a.copies(), a.target.width, a.target.height]).toEqual([0, 1, source.width, source.height]);

      const b = view();
      draw(0x40a0ff);
      expect(source.parentNode).toBe(body);
      expect([source.style.cssText, source.getAttribute("aria-hidden")]).toEqual(["display: none", null]);
      expect([a.target.pixel, b.target.pixel]).toEqual([0x40a0ff, 0x40a0ff]);

      setRegisteredViewEnabled(b.view, false);
      draw(0x10ff10);
      expect([source.parentNode, source.pixel]).toEqual([a.panel, 0x10ff10]);
      b.release();
    } finally { a.release(); engine.dispose(); }
  });

  it("keeps the last coherent image after an incoherent frame or a resize between steps", () => {
    useFakeHeldImages();
    const { engine, source, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      draw(0x0000ff, false); // drew, then the frame turned out incoherent
      expect([source.pixel, a.copies(), source.style.visibility]).toEqual([0xff8040, 1, "visible"]);
      engine.setSize(64, 48); // a ResizeObserver resize between frames reallocates the buffer
      expect(source.pixel).toBe(0xff8040);
      draw(0x40a0ff);
      expect([source.pixel, a.copies()]).toEqual([0x40a0ff, 2]);
    } finally { a.release(); engine.dispose(); }
  });

  it("does no GPU copy on a step that draws nothing, unless that step resized the buffer", () => {
    const blits = useFakeHeldImages();
    const { engine, source, draw, idle, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      const after = blits.count;
      idle();
      idle();
      expect([blits.count, source.pixel, source.style.visibility]).toEqual([after, 0xff8040, "visible"]);
      // The view grew: its step resizes (clears) the buffer before the loop declines.
      a.target.clientWidth = 48;
      idle();
      expect([source.width, source.pixel, source.style.visibility]).toEqual([48, 0xff8040, "visible"]);
    } finally { a.release(); engine.dispose(); }
  });

  it("presents a view directly while the only other enabled view sits in a hidden tab", () => {
    useFakeHeldImages();
    const { engine, body, source, draw, view } = host();
    const scene = view();
    const hidden = view();
    Object.assign(hidden.target, { clientWidth: 0, clientHeight: 0 }); // display: none; admission holds it
    try {
      draw(0xff8040);
      expect([source.parentNode, hidden.target.pixel]).toEqual([scene.panel, 0]);
      Object.assign(hidden.target, { clientWidth: 32, clientHeight: 32 });
      draw(0x40a0ff);
      expect([source.parentNode, scene.target.pixel, hidden.target.pixel]).toEqual([body, 0x40a0ff, 0x40a0ff]);
    } finally { hidden.release(); scene.release(); engine.dispose(); }
  });

  it("copies into a view canvas in another document (a popout window)", () => {
    useFakeHeldImages();
    const { engine, body, source, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      expect(source.parentNode).toBe(a.panel);
      a.target.ownerDocument = {};
      draw(0x40a0ff);
      expect([source.parentNode, a.target.pixel]).toEqual([body, 0x40a0ff]);
    } finally { a.release(); engine.dispose(); }
  });

  it("stops tracking a view canvas once it is no longer covered, and on release", () => {
    useFakeHeldImages();
    const { engine, source, draw, view } = host();
    const a = view();
    const synced = (target: FakeCanvas) => {
      target.pixel = 0;
      syncDirectViewCanvas(target);
      return target.pixel;
    };
    try {
      draw(0xff8040);
      expect(synced(a.target)).toBe(0xff8040);
      // Removed from the document while its step draws: it keeps that frame and is untracked.
      draw(0x40a0ff, true, () => a.panel.removeChild(a.target));
      expect([source.style.visibility, a.target.pixel, synced(a.target)]).toEqual(["hidden", 0x40a0ff, 0]);
      a.panel.insertBefore(a.target, null);
      draw(0x10ff10);
      expect(synced(a.target)).toBe(0x10ff10);
    } finally { a.release(); }
    expect(synced(a.target)).toBe(0);
    engine.dispose();
  });

  it("never puts a disposed Engine's removed canvas back into the document", () => {
    useFakeHeldImages();
    const { engine, source, draw, view } = host();
    const a = view();
    draw(0xff8040);
    expect(source.parentNode).toBe(a.panel);
    // The session disposes the Engine and removes its canvas before the viewport releases its view.
    engine.dispose();
    source.parentNode?.removeChild(source);
    a.release();
    expect(source.parentNode).toBeNull();
  });

  it("hands a departing sole view its last frame and moves only after the next view is coherent", () => {
    useFakeHeldImages();
    const { engine, source, draw, view } = host();
    const editor = view();
    const play = view();
    setRegisteredViewEnabled(play.view, false);
    try {
      draw(0xff8040);
      expect(source.parentNode).toBe(editor.panel);
      // Play holds the editor view; its first frame is still loading.
      setRegisteredViewEnabled(editor.view, false);
      setRegisteredViewEnabled(play.view, true);
      draw(0x0000ff, false);
      expect([editor.target.pixel, source.style.visibility]).toEqual([0xff8040, "hidden"]);
      draw(0x40a0ff);
      expect([source.parentNode, source.style.visibility]).toEqual([play.panel, "visible"]);
      // Play closes; the editor's first frame back is incoherent and shows its held image.
      setRegisteredViewEnabled(play.view, false);
      setRegisteredViewEnabled(editor.view, true);
      draw(0x00ff00, false);
      expect([source.parentNode, source.pixel, play.target.pixel]).toEqual([editor.panel, 0xff8040, 0x40a0ff]);
    } finally { play.release(); editor.release(); engine.dispose(); }
  });

  it("adopts the fresh canvas of a replacement Engine and returns the released one", () => {
    useFakeHeldImages();
    const first = host();
    const a = first.view();
    first.draw(0xff8040);
    expect(first.source.parentNode).toBe(a.panel);
    a.release();
    first.engine.dispose();
    expect(first.source.parentNode).toBe(first.body);
    // A backend fallback creates another Engine on a fresh canvas for the same view canvas.
    const second = host();
    const b = second.view(a.target);
    try {
      second.draw(0x40a0ff);
      expect([second.source.parentNode, first.source.parentNode]).toEqual([a.panel, first.body]);
    } finally { b.release(); second.engine.dispose(); }
  });

  it("copies when direct presentation is unavailable or switched off", () => {
    setHeldImageStoreFactoryForTests(() => null); // WebGPU, WebGL1 or a multisampled default framebuffer
    const unavailable = host();
    const a = unavailable.view();
    try {
      unavailable.draw(0xff8040);
      expect([unavailable.source.parentNode, a.target.pixel]).toEqual([unavailable.body, 0xff8040]);
    } finally { a.release(); unavailable.engine.dispose(); }
    useFakeHeldImages();
    setDirectViewPresentationEnabled(false);
    const off = host();
    const b = off.view();
    try {
      off.draw(0x40a0ff);
      expect([off.source.parentNode, b.target.pixel]).toEqual([off.body, 0x40a0ff]);
      setDirectViewPresentationEnabled(true);
      off.draw(0x10ff10);
      expect(off.source.parentNode).toBe(b.panel);
    } finally { b.release(); off.engine.dispose(); }
  });

  it("engages the store before a direct step draws, and copies once the store reports it cannot work", () => {
    let usable = true;
    const order: string[] = [];
    useFakeHeldImages({ engage: () => { order.push("engage"); }, usable: () => usable });
    const { engine, body, source, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040, true, () => order.push("draw"));
      expect([order, source.parentNode]).toEqual([["engage", "draw"], a.panel]);
      usable = false; // e.g. the WebGPU main pass stopped rendering into the store's target
      draw(0x40a0ff);
      expect([source.parentNode, a.target.pixel, order.length]).toEqual([body, 0x40a0ff, 2]);
    } finally { a.release(); engine.dispose(); }
  });

  it("copies a coherent frame the store could not present instead of showing its held image again", () => {
    let off = false;
    useFakeHeldImages({ usable: () => !off, off: () => off });
    const { engine, body, source, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      expect([source.parentNode, a.copies()]).toEqual([a.panel, 1]);
      // The store turns itself off while this frame draws (WebGPU then renders the frame into the canvas).
      draw(0x40a0ff, true, () => { off = true; });
      expect([source.parentNode, a.target.pixel, a.copies()]).toEqual([body, 0x40a0ff, 2]);
    } finally { a.release(); engine.dispose(); }
  });

  it("keeps copying a view whose presentation disallows direct presentation", () => {
    let engaged = 0;
    // On WebGPU, engaging the store redirects Babylon's main pass; a copying Engine must never be touched.
    useFakeHeldImages({ engage: () => { engaged++; } });
    let allowed = false;
    const { engine, body, source, draw, view } = host();
    const a = view(undefined, { allowDirect: () => allowed });
    try {
      // An Engine not declared for direct presentation (the exported player's): the Engine canvas stays parked and the view canvas gets the pixels.
      draw(0xff8040);
      expect([source.parentNode, a.target.pixel, engaged]).toEqual([body, 0xff8040, 0]);
      allowed = true;
      draw(0x40a0ff);
      expect([source.parentNode, engaged]).toEqual([a.panel, 1]);
    } finally { a.release(); engine.dispose(); }
  });

  it("writes the presented image into a directly presented view canvas on request", () => {
    useFakeHeldImages();
    const { engine, draw, view } = host();
    const a = view();
    try {
      draw(0xff8040);
      expect(a.target.pixel).toBe(0);
      syncDirectViewCanvas(a.target);
      expect(a.target.pixel).toBe(0xff8040);
    } finally { a.release(); engine.dispose(); }
  });
});

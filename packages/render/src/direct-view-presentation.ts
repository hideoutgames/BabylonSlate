import type { AbstractEngine, EngineView } from "@babylonjs/core";

/**
 * Direct view presentation. While exactly one enabled registered view is laid
 * out (has a box), the project Engine's own canvas is placed over that view's
 * canvas and shown, instead of copying the Engine canvas into the view's 2D
 * canvas every frame (a CPU blit plus a CPU/GPU sync on WebKit, a GPU copy on
 * Chromium).
 *
 * The visible image still changes only after a coherent frame: every coherent
 * frame copies the default framebuffer into the view's held image on the GPU,
 * and a frame that drew something incoherent copies the held image back before
 * the browser presents. A step that drew nothing copies nothing. Resizes
 * restore the held image into the new buffer. When presentation moves to
 * another view, or back to copying, the departing view's 2D canvas receives
 * its held image once, so it keeps its last frame like a copied view.
 */

/** GPU copies of each view's last coherent frame. */
export interface HeldImageStore {
  /** Copy the Engine's default framebuffer (`width` × `height`) into the view's held image. */
  snapshot(view: EngineView, width: number, height: number): void;
  /** Copy the view's held image into the default framebuffer, scaled to `width` × `height`. False when it has none. */
  restore(view: EngineView, width: number, height: number): boolean;
  size(view: EngineView): { width: number; height: number } | null;
  release(view: EngineView): void;
  /** Forget every held image; `lost` skips GL deletes after a context loss. */
  clear(lost?: boolean): void;
}

type WebGlEngine = AbstractEngine & {
  _gl?: WebGL2RenderingContext;
  _currentFramebuffer?: WebGLFramebuffer | null;
  webGLVersion?: number;
};

/**
 * The WebGL2 store, or null when the Engine cannot present directly: WebGPU,
 * WebGL1, a multisampled default framebuffer (a blit cannot write into it) or
 * an OffscreenCanvas rendering surface. Those keep the copy path.
 */
export function createWebGl2HeldImageStore(engine: AbstractEngine): HeldImageStore | null {
  const native = engine as WebGlEngine;
  const gl = native._gl;
  if (engine.isWebGPU || !gl || native.webGLVersion !== 2 || typeof gl.blitFramebuffer !== "function") return null;
  if (gl.getContextAttributes()?.antialias) return null;
  if (typeof HTMLCanvasElement === "undefined" || !(engine.getRenderingCanvas() instanceof HTMLCanvasElement)) return null;
  type Held = { framebuffer: WebGLFramebuffer; renderbuffer: WebGLRenderbuffer; width: number; height: number };
  const held = new Map<EngineView, Held>();
  // Babylon caches only the FRAMEBUFFER binding; restore exactly that one.
  const rebind = () => gl.bindFramebuffer(gl.FRAMEBUFFER, native._currentFramebuffer ?? null);
  const blit = (read: WebGLFramebuffer | null, draw: WebGLFramebuffer | null, from: { width: number; height: number }, to: { width: number; height: number }) => {
    // Blits honour only the scissor test among fragment operations; Babylon
    // enables it per pass and never caches it.
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
    const same = from.width === to.width && from.height === to.height;
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.COLOR_BUFFER_BIT, same ? gl.NEAREST : gl.LINEAR);
    rebind();
  };
  const drop = (entry: Held) => {
    gl.deleteFramebuffer(entry.framebuffer);
    gl.deleteRenderbuffer(entry.renderbuffer);
  };
  const allocate = (view: EngineView, width: number, height: number): Held | null => {
    const previous = held.get(view);
    if (previous && previous.width === width && previous.height === height) return previous;
    if (previous) drop(previous);
    held.delete(view);
    const renderbuffer = gl.createRenderbuffer();
    const framebuffer = gl.createFramebuffer();
    if (!renderbuffer || !framebuffer) return null;
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
    rebind();
    const entry = { framebuffer, renderbuffer, width, height };
    held.set(view, entry);
    return entry;
  };
  return {
    snapshot(view, width, height) {
      const entry = allocate(view, width, height);
      if (entry) blit(null, entry.framebuffer, entry, { width, height });
    },
    restore(view, width, height) {
      const entry = held.get(view);
      if (!entry || width < 1 || height < 1) return false;
      blit(entry.framebuffer, null, entry, { width, height });
      return true;
    },
    size(view) {
      const entry = held.get(view);
      return entry ? { width: entry.width, height: entry.height } : null;
    },
    release(view) {
      const entry = held.get(view);
      if (entry) drop(entry);
      held.delete(view);
    },
    clear(lost = false) {
      if (!lost) for (const entry of held.values()) drop(entry);
      held.clear();
    },
  };
}

/** Where the Engine canvas sits. It covers one view canvas at a time and never takes pointer input. */
export interface EngineCanvasPlacement {
  /** The view the canvas covers, or null when it covers none. */
  readonly view: EngineView | null;
  /** Whether `view`'s canvas can be covered: it is in this canvas's document (not a popout window). */
  canCover(view: EngineView): boolean;
  /**
   * Cover `view`'s canvas and show it; while it does, `sync` writes the shown
   * image into the view canvas on a read (see `syncDirectViewCanvas`). False
   * when that canvas cannot be covered.
   */
  show(view: EngineView, sync: () => void): boolean;
  /** Re-measure the covered view's box (resize, dock moves). */
  follow(): void;
  /** Stop covering any view, invisibly, without moving the canvas yet. */
  vacate(): void;
  /** Return the canvas to where and how it was before the first `show`; a disposed Engine's canvas is only removed. */
  park(): void;
}

/** Styles of a placed Engine canvas: out of flow over its view, input passes through to the view canvas. */
const PLACED_STYLE: Record<string, string> = {
  position: "absolute", left: "0px", top: "0px", margin: "0", padding: "0", border: "0",
  display: "block", pointerEvents: "none", transform: "none", visibility: "hidden",
};

export function createEngineCanvasPlacement(canvas: HTMLCanvasElement, isDisposed: () => boolean = () => false): EngineCanvasPlacement {
  let view: EngineView | null = null;
  let original: { parent: ParentNode | null; next: Node | null; cssText: string; ariaHidden: string | null } | null = null;
  let offset = { x: 0, y: 0 };
  let box = { width: -1, height: -1 };
  let observer: ResizeObserver | null = null;
  const style = canvas.style as unknown as Record<string, string>;
  const measure = () => {
    if (!view) return;
    const target = view.target.getBoundingClientRect();
    const own = canvas.getBoundingClientRect();
    // Device-pixel offsets: a sub-pixel layout difference neither misaligns
    // the image nor rewrites the style (and re-runs layout) every frame.
    const ratio = canvas.ownerDocument?.defaultView?.devicePixelRatio || 1;
    const snap = (value: number) => Math.round(value * ratio) / ratio;
    const x = snap(offset.x + (target.left - own.left));
    const y = snap(offset.y + (target.top - own.top));
    if (x !== offset.x || y !== offset.y) {
      offset = { x, y };
      style.left = `${x}px`;
      style.top = `${y}px`;
    }
    if (target.width !== box.width || target.height !== box.height) {
      box = { width: target.width, height: target.height };
      style.width = `${target.width}px`;
      style.height = `${target.height}px`;
    }
  };
  const vacate = () => {
    observer?.disconnect();
    if (view) trackDirectViewTarget(view.target, null);
    view = null;
    style.visibility = "hidden";
  };
  const canCover = (next: EngineView) => {
    const target = next.target;
    return target.isConnected && target.parentNode !== null && target.ownerDocument === canvas.ownerDocument;
  };
  return {
    get view() { return view; },
    canCover,
    show(next, sync) {
      const target = next.target;
      const parent = target.parentNode;
      if (!canCover(next) || !parent) { vacate(); return false; }
      if (!original) {
        original = { parent: canvas.parentNode, next: canvas.nextSibling, cssText: canvas.style.cssText, ariaHidden: canvas.getAttribute("aria-hidden") };
        // The view canvas carries the viewport's semantics; the image over it is decoration.
        canvas.setAttribute("aria-hidden", "true");
      }
      if (canvas.parentNode !== parent || canvas.previousSibling !== target) parent.insertBefore(canvas, target.nextSibling);
      if (view !== next) {
        if (view) trackDirectViewTarget(view.target, null);
        observer?.disconnect();
        Object.assign(style, PLACED_STYLE);
        offset = { x: 0, y: 0 };
        box = { width: -1, height: -1 };
        view = next;
        if (typeof ResizeObserver !== "undefined") {
          observer ??= new ResizeObserver(() => measure());
          observer.observe(target);
        }
      }
      trackDirectViewTarget(target, sync);
      measure();
      style.visibility = "visible";
      return true;
    },
    follow: measure,
    vacate,
    park() {
      vacate();
      if (!original) return;
      const { parent, next, cssText, ariaHidden } = original;
      original = null;
      canvas.style.cssText = cssText;
      if (ariaHidden === null) canvas.removeAttribute("aria-hidden");
      else canvas.setAttribute("aria-hidden", ariaHidden);
      // A disposed Engine's owner may already have removed its canvas; never put it back.
      if (!isDisposed() && parent && (parent as Node).isConnected !== false) parent.insertBefore(canvas, next && next.parentNode === parent ? next : null);
      else canvas.parentNode?.removeChild(canvas);
    },
  };
}

let directEnabled = true;

/** Direct presentation switch (on by default); off forces the copy path, e.g. for an A/B. */
export function setDirectViewPresentationEnabled(enabled: boolean): void {
  directEnabled = enabled;
}

export function directViewPresentationEnabled(): boolean {
  return directEnabled;
}

/**
 * View canvases presented directly right now, with the step that writes their
 * held image into them. Entries go when a view stops being covered or is
 * released; weak keys keep a dropped canvas from holding its Engine regardless.
 */
const directTargets = new WeakMap<HTMLCanvasElement, () => void>();

export function trackDirectViewTarget(target: HTMLCanvasElement, sync: (() => void) | null): void {
  if (sync) directTargets.set(target, sync);
  else directTargets.delete(target);
}

/** Write the presented image into a directly presented view canvas so it reads like a copied one. */
export function syncDirectViewCanvas(target: unknown): void {
  if (target && typeof target === "object") directTargets.get(target as HTMLCanvasElement)?.();
}

let readSyncInstalled = false;

/**
 * Test builds only: reading a directly presented view canvas (drawImage source,
 * getImageData, toDataURL, toBlob, createImageBitmap) first writes the presented
 * image into it, so pixel probes see what the screen shows.
 */
export function installDirectViewReadSync(): void {
  if (readSyncInstalled || typeof window === "undefined" || typeof CanvasRenderingContext2D === "undefined") return;
  readSyncInstalled = true;
  type Method = (this: unknown, ...args: unknown[]) => unknown;
  const wrap = (owner: object, name: string, sourceOf: (self: unknown, args: unknown[]) => unknown) => {
    const host = owner as Record<string, Method>;
    const original = host[name];
    if (typeof original !== "function") return;
    host[name] = function (this: unknown, ...args: unknown[]) {
      syncDirectViewCanvas(sourceOf(this, args));
      // A bare createImageBitmap(...) call has no receiver.
      return original.apply(this ?? window, args);
    };
  };
  wrap(CanvasRenderingContext2D.prototype, "drawImage", (_self, args) => args[0]);
  wrap(CanvasRenderingContext2D.prototype, "getImageData", (self) => (self as CanvasRenderingContext2D).canvas);
  wrap(HTMLCanvasElement.prototype, "toDataURL", (self) => self);
  wrap(HTMLCanvasElement.prototype, "toBlob", (self) => self);
  wrap(window as unknown as object, "createImageBitmap", (_self, args) => args[0]);
}

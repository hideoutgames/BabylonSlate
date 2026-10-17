import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Observable, type AbstractEngine, type EngineView } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebGpuHeldImageStore } from "./webgpu-held-image-store";

class FakeCanvasElement {}

/** A canvas whose displayed image is what the last presented canvas texture held; a resize clears it. */
class FakeCanvas extends FakeCanvasElement {
  displayed = 0;
  private size = { width: 64, height: 48 };
  get width() { return this.size.width; }
  set width(value: number) { this.size.width = value; this.displayed = 0; }
  get height() { return this.size.height; }
  set height(value: number) { this.size.height = value; this.displayed = 0; }
}

class FakeTexture {
  content = 0;
  destroyed = false;
  constructor(readonly label: string, readonly width: number, readonly height: number) {}
  destroy() { this.destroyed = true; }
}

/**
 * The Babylon 9.29 WebGPUEngine members the store relies on, reduced to what
 * they do: the main pass binds whatever `this._context.getCurrentTexture()`
 * returns, and `_configureContext` configures the canvas.
 */
function fakeEngine(options: { antialias?: boolean } = {}) {
  const canvas = new FakeCanvas();
  const created: FakeTexture[] = [];
  const configurations: Array<Record<string, unknown>> = [];
  const copies: Array<{ from: FakeTexture; to: FakeTexture; size: number[] }> = [];
  let canvasTexture: FakeTexture | null = null;
  let acquisitions = 0;
  const context = {
    getCurrentTexture() {
      if (!canvasTexture) { canvasTexture = new FakeTexture("canvas", canvas.width, canvas.height); acquisitions++; }
      return canvasTexture;
    },
    configure(configuration: Record<string, unknown>) { configurations.push(configuration); canvas.displayed = 0; },
  };
  const hardware = { underlyingResource: null as FakeTexture | null, set(texture: FakeTexture) { this.underlyingResource = texture; } };
  const engine = {
    isWebGPU: true,
    onEndFrameObservable: new Observable<unknown>(),
    getRenderingCanvas: () => canvas,
    flushFramebuffer: vi.fn(),
    _options: { antialias: options.antialias ?? false, swapChainFormat: "bgra8unorm" },
    _device: {
      createTexture: (descriptor: { label: string; size: number[] }) => {
        const texture = new FakeTexture(descriptor.label, descriptor.size[0]!, descriptor.size[1]!);
        created.push(texture);
        return texture;
      },
      createCommandEncoder: () => ({
        copyTextureToTexture(source: { texture: FakeTexture }, destination: { texture: FakeTexture }, size: number[]) {
          copies.push({ from: source.texture, to: destination.texture, size });
          destination.texture.content = source.texture.content;
        },
        finish: () => ({}),
      }),
      queue: { submit: vi.fn() },
    },
    _context: context,
    _mainRenderPassWrapper: { colorAttachmentGPUTextures: [hardware] },
    _startMainRenderPass(this: { _context: typeof context; _mainRenderPassWrapper: { colorAttachmentGPUTextures: Array<typeof hardware> } }) {
      this._mainRenderPassWrapper.colorAttachmentGPUTextures[0]!.set(this._context.getCurrentTexture());
    },
    _configureContext(this: { _context: typeof context }) {
      this._context.configure({ device: "device", format: "bgra8unorm", usage: 0x11, alphaMode: "premultiplied" });
    },
  };
  /** One frame: optionally draw `color` through the main pass, then end the task (present an acquired canvas texture). */
  const frame = (color: number | null, between?: () => void) => {
    if (color !== null) {
      engine._startMainRenderPass();
      hardware.underlyingResource!.content = color;
    }
    between?.();
    engine.onEndFrameObservable.notifyObservers(engine);
    if (canvasTexture) canvas.displayed = canvasTexture.content;
    canvasTexture = null;
  };
  return {
    engine: engine as unknown as AbstractEngine, native: engine, canvas, hardware, created, configurations, copies,
    acquisitions: () => acquisitions, frame,
  };
}

const view = {} as EngineView;

beforeEach(() => { vi.stubGlobal("HTMLCanvasElement", FakeCanvasElement); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WebGPU direct presentation store", () => {
  it("draws into its own target and copies only coherent frames to the canvas", () => {
    const fake = fakeEngine();
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => expect(store.snapshot(view, 64, 48)).toBe(true));
    expect([fake.canvas.displayed, fake.acquisitions()]).toEqual([0xff8040, 1]);
    expect(fake.copies[0]?.from.label).toMatch(/^DirectViewTarget/);

    // Incoherent: drawn, never presented; the canvas keeps the coherent frame without a copy.
    store.engage!();
    fake.frame(0x0000ff, () => expect(store.restore(view, 64, 48)).toBe(true));
    // Idle: nothing drawn at all.
    store.engage!();
    fake.frame(null);
    expect([fake.canvas.displayed, fake.acquisitions(), fake.copies.length]).toEqual([0xff8040, 1, 1]);

    // The next coherent frame draws into the other target, not over the held one.
    store.engage!();
    fake.frame(0x10ff10, () => store.snapshot(view, 64, 48));
    expect([fake.canvas.displayed, store.size(view)]).toEqual([0x10ff10, { width: 64, height: 48 }]);
    expect(fake.copies[1]!.from).not.toBe(fake.copies[0]!.from);
  });

  it("refuses a snapshot when the step drew nothing into its target", () => {
    const fake = fakeEngine();
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(null, () => expect(store.snapshot(view, 64, 48)).toBe(false));
    expect(fake.acquisitions()).toBe(0);
  });

  it("puts the held frame back once after a resize and destroys replaced targets after their frame", () => {
    const fake = fakeEngine();
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    store.engage!();
    fake.frame(0x0000ff); // fills the second target at the old size
    const old = fake.created.slice();
    fake.canvas.width = 80; // Babylon's setSize; the browser clears the canvas
    store.engage!();
    fake.frame(0x00ff00, () => {
      expect(store.restore(view, 80, 48)).toBe(true);
      expect(old.every((texture) => !texture.destroyed)).toBe(true);
    });
    expect([fake.canvas.displayed, fake.copies.at(-1)?.size]).toEqual([0xff8040, [64, 48, 1]]);
    // The draw target was replaced at the new size; the held frame stays until a coherent frame replaces it.
    expect(old.map((texture) => texture.destroyed)).toEqual([false, true]);
    store.engage!();
    fake.frame(0x0000ff, () => expect(store.restore(view, 80, 48)).toBe(true));
    expect(fake.acquisitions()).toBe(2);
  });

  it("makes the held frame readable in the task on request", () => {
    const fake = fakeEngine();
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    fake.frame(null, () => expect(store.restore(view, 64, 48, true)).toBe(true));
    expect([fake.acquisitions(), fake.canvas.displayed]).toEqual([2, 0xff8040]);
    expect(store.restore({} as EngineView, 64, 48, true)).toBe(false);
  });

  it("adds copy-destination use to Babylon's canvas configuration and keeps the rest", () => {
    const fake = fakeEngine();
    createWebGpuHeldImageStore(fake.engine);
    expect(fake.configurations.at(-1)).toEqual({ device: "device", format: "bgra8unorm", usage: 0x13, alphaMode: "premultiplied" });
  });

  it("keeps the copy path when the Engine's internals differ", () => {
    expect(createWebGpuHeldImageStore(fakeEngine({ antialias: true }).engine)).toBeNull();
    const missing = fakeEngine();
    Reflect.deleteProperty(missing.native, "_startMainRenderPass");
    expect(createWebGpuHeldImageStore(missing.engine)).toBeNull();
    // A main pass that no longer acquires through this._context turns the store off at its first frame.
    const moved = fakeEngine();
    const context = moved.native._context;
    moved.native._startMainRenderPass = function (this: typeof moved.native) {
      this._mainRenderPassWrapper.colorAttachmentGPUTextures[0]!.set(context.getCurrentTexture());
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createWebGpuHeldImageStore(moved.engine)!;
    store.engage!();
    moved.frame(0xff8040, () => expect(store.snapshot(view, 64, 48)).toBe(false));
    expect([store.usable!(), warn.mock.calls.length]).toEqual([false, 1]);
    store.engage!();
    expect(store.restore(view, 64, 48)).toBe(false);
  });

  it("destroys its textures on clear and dispose, keeps them on a lost device, and restores Babylon's members", () => {
    const fake = fakeEngine();
    const { _startMainRenderPass: start, _configureContext: configure } = fake.native;
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    store.engage!();
    fake.frame(0x0000ff);
    store.clear(true); // device lost: its textures are gone with it
    fake.frame(null);
    expect(fake.created.map((texture) => texture.destroyed)).toEqual([false, false]);

    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    store.clear();
    expect(fake.created[2]!.destroyed).toBe(false); // this frame may still use it
    fake.frame(null);
    expect(fake.created[2]!.destroyed).toBe(true);
    fake.frame(null); // not engaged: Babylon renders into the canvas again
    fake.native._startMainRenderPass();
    expect(fake.hardware.underlyingResource?.label).toBe("canvas");

    store.engage!();
    fake.frame(0x00ff00);
    store.dispose!();
    expect(fake.created.at(-1)!.destroyed).toBe(true);
    expect([fake.native._startMainRenderPass, fake.native._configureContext]).toEqual([start, configure]);
    expect(fake.native.onEndFrameObservable.hasObservers()).toBe(false);
  });
});

/**
 * Babylon internals this store depends on. When the Babylon pin moves and one
 * of these fails, re-check webgpu-held-image-store.ts against the new source
 * before updating the expectations.
 */
describe("Babylon WebGPUEngine internals for direct presentation", () => {
  const require = createRequire(import.meta.url);
  const engineSource = readFileSync(require.resolve("@babylonjs/core/Engines/webgpuEngine.pure.js"), "utf8");
  const method = (source: string, signature: string) => {
    const start = source.indexOf(`\n    ${signature} {`);
    expect(start, `${signature} exists`).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    return source.slice(start, end);
  };

  it("acquires the canvas texture only in _startMainRenderPass, through this._context, and binds it", () => {
    expect(engineSource.match(/getCurrentTexture\(/g)).toHaveLength(1);
    const start = method(engineSource, "_startMainRenderPass(setClearStates, clearColor, clearDepth, clearStencil)");
    expect(start).toContain("const swapChainTexture = this._context.getCurrentTexture();");
    expect(start).toContain("this._mainRenderPassWrapper.colorAttachmentGPUTextures[0].set(swapChainTexture);");
    expect(start).toContain("this._options.antialias");
  });

  it("configures the canvas only in _configureContext, through this._context, with a usage", () => {
    expect(engineSource.match(/\.configure\(\{/g)).toHaveLength(1);
    const configure = method(engineSource, "_configureContext()");
    expect(configure).toContain("this._context.configure({");
    expect(configure).toMatch(/usage: 16 \/\* [^*]+\*\/ \| 1 \/\* [^*]+\*\//);
    expect(method(engineSource, "_initializeContextAndSwapChain()")).toContain("this._configureContext();");
  });

  it("resizes through _initializeMainAttachments and submits on flushFramebuffer", () => {
    expect(method(engineSource, "setSize(width, height, forceSetSize = false)")).toContain("this._initializeMainAttachments();");
    expect(method(engineSource, "flushFramebuffer(_fromEndFrame = false)")).toContain("this._device.queue.submit(");
  });

  it("exposes the bound texture as underlyingResource", () => {
    const hardware = readFileSync(require.resolve("@babylonjs/core/Engines/WebGPU/webgpuHardwareTexture.js"), "utf8");
    expect(method(hardware, "get underlyingResource()")).toContain("return this._webgpuTexture;");
    expect(method(hardware, "set(hardwareTexture)")).toContain("this._webgpuTexture = hardwareTexture;");
  });
});

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
function fakeEngine(options: { antialias?: boolean; validation?: (scope: number) => Promise<{ message: string } | null> } = {}) {
  const canvas = new FakeCanvas();
  const created: FakeTexture[] = [];
  const configurations: Array<Record<string, unknown>> = [];
  const copies: Array<{ from: FakeTexture; to: FakeTexture; size: number[] }> = [];
  let canvasTexture: FakeTexture | null = null;
  let acquisitions = 0;
  let scopes = 0;
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
      ...(options.validation ? {
        pushErrorScope: () => { scopes++; },
        popErrorScope: () => options.validation!(scopes),
      } : {}),
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
    acquisitions: () => acquisitions, scopes: () => scopes, frame,
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

  it("leaves the Engine alone until a step presents directly, then adds copy-destination use to Babylon's canvas configuration", () => {
    const fake = fakeEngine();
    const { _startMainRenderPass: start } = fake.native;
    const store = createWebGpuHeldImageStore(fake.engine)!;
    expect([fake.configurations.length, fake.native._startMainRenderPass]).toEqual([0, start]);
    store.engage!();
    expect(fake.configurations).toEqual([{ device: "device", format: "bgra8unorm", usage: 0x13, alphaMode: "premultiplied" }]);
    expect(fake.native.flushFramebuffer).toHaveBeenCalledTimes(1);
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

  it("renders into the canvas when the main pass needs more of the canvas context than the target stands in for", () => {
    const fake = fakeEngine();
    const start = fake.native._startMainRenderPass;
    fake.native._startMainRenderPass = function (this: typeof fake.native) {
      (this._context as unknown as { canvas: FakeCanvas }).canvas.width.toFixed();
      start.call(this);
    };
    (fake.native._context as unknown as { canvas: FakeCanvas }).canvas = fake.canvas;
    const own = fake.native._startMainRenderPass;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => expect(store.snapshot(view, 64, 48)).toBe(false));
    // The frame still reached the screen, and Babylon's member is its own again.
    expect([fake.canvas.displayed, store.usable!(), fake.native._startMainRenderPass]).toEqual([0xff8040, false, own]);
  });

  it("never redirects the main pass once the canvas configuration turns out to differ", () => {
    const fake = fakeEngine();
    fake.native._configureContext = function (this: { _context: { configure(configuration: object): void; canvas?: unknown } }) {
      this._context.configure({ device: "device", format: "bgra8unorm", usage: 0x11, canvas: this._context.canvas!.toString() });
    };
    (fake.native._context as unknown as { canvas: FakeCanvas }).canvas = fake.canvas;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => expect(store.snapshot(view, 64, 48)).toBe(false));
    expect([fake.canvas.displayed, store.usable!(), fake.configurations.at(-1)?.usage]).toEqual([0xff8040, false, 0x11]);
  });

  it("turns off and puts Babylon's canvas configuration back when the device rejects the configuration or the first copy", async () => {
    for (const rejected of [1, 2]) {
      // Scope 1 wraps the configuration with copy-destination use, scope 2 the first copy.
      const fake = fakeEngine({ validation: async (scope) => (scope === rejected ? { message: "usage not supported" } : null) });
      const { _startMainRenderPass: start, _configureContext: configure } = fake.native;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = createWebGpuHeldImageStore(fake.engine)!;
      store.engage!();
      fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
      await vi.waitFor(() => expect(store.usable!()).toBe(false));
      expect([fake.native._startMainRenderPass, fake.native._configureContext, warn.mock.calls.length]).toEqual([start, configure, 1]);
      // Reconfiguring clears the canvas, which may still cover the view: it waits until the presenter vacates.
      expect(fake.configurations.map((configuration) => configuration.usage)).toEqual([0x13]);
      store.clear();
      expect(fake.configurations.map((configuration) => configuration.usage)).toEqual([0x13, 0x11]);
      warn.mockRestore();
    }
  });

  it("puts Babylon's canvas configuration back at once when the rejection arrives after presentation stopped", async () => {
    const fake = fakeEngine({ validation: async (scope) => (scope === 2 ? { message: "copy failed" } : null) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    store.clear(); // e.g. a second view appeared: views copy, the Engine canvas is parked
    await vi.waitFor(() => expect(store.usable!()).toBe(false));
    expect(fake.configurations.map((configuration) => configuration.usage)).toEqual([0x13, 0x11]);
  });

  it("keeps presenting through a lost device and checks the restored device's first copy again", async () => {
    const fake = fakeEngine({ validation: () => Promise.reject(new Error("device lost")) });
    const store = createWebGpuHeldImageStore(fake.engine)!;
    store.engage!();
    fake.frame(0xff8040, () => store.snapshot(view, 64, 48));
    expect(fake.scopes()).toBe(2);
    store.clear(true);
    await Promise.resolve();
    store.engage!();
    fake.frame(0x40a0ff, () => expect(store.snapshot(view, 64, 48)).toBe(true));
    expect([store.usable!(), fake.canvas.displayed, fake.scopes()]).toEqual([true, 0x40a0ff, 3]);
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
    fake.frame(0x00ff00, () => {
      // Released mid-frame, perhaps the last frame there will be: the frame's passes are submitted before the
      // targets they use are destroyed.
      const order: string[] = [];
      fake.native.flushFramebuffer.mockImplementation(() => { order.push("submit"); });
      const target = fake.created.at(-1)!;
      const destroy = target.destroy.bind(target);
      target.destroy = () => { order.push("destroy"); destroy(); };
      store.dispose!();
      expect(order).toEqual(["submit", "destroy"]);
    });
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

  it("submits a frame's passes before its end-frame observers run, including the main pass a resize starts", () => {
    // Replaced targets are destroyed by an end-frame observer: every pass that used them must be submitted by then.
    const inOrder = (body: string, lines: string[]) => {
      const at = lines.map((line) => body.indexOf(line));
      return at.every((index, position) => index > -1 && (position === 0 || index > at[position - 1]!));
    };
    expect(inOrder(method(engineSource, "endFrame()"), ["this.flushFramebuffer(true);", "super.endFrame();"])).toBe(true);
    expect(inOrder(method(engineSource, "_initializeMainAttachments()"), [
      "this.flushFramebuffer();", "this.beginFrame();", "this._startMainRenderPass(true, null, true, false);", "this.endFrame();",
    ])).toBe(true);
  });

  it("exposes the bound texture as underlyingResource", () => {
    const hardware = readFileSync(require.resolve("@babylonjs/core/Engines/WebGPU/webgpuHardwareTexture.js"), "utf8");
    expect(method(hardware, "get underlyingResource()")).toContain("return this._webgpuTexture;");
    expect(method(hardware, "set(hardwareTexture)")).toContain("this._webgpuTexture = hardwareTexture;");
  });
});

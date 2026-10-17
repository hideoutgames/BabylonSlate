import type { AbstractEngine, EngineView } from "@babylonjs/core";
import type { HeldImageStore } from "./direct-view-presentation";

/**
 * WebGPU direct presentation (pinned to Babylon 9.29 internals). Without MSAA,
 * Babylon's main pass renders straight into the canvas texture
 * (`this._context.getCurrentTexture()` in `_startMainRenderPass`), and an
 * acquired canvas texture is presented when the task ends. While a view is
 * presented directly, the main pass renders into one of two owned textures
 * instead: a coherent frame copies its texture to the canvas, and any other
 * frame never acquires the canvas, which keeps showing its last image. The
 * other texture keeps the last coherent frame, for a resize (which clears the
 * canvas) and for handing that frame to the view canvas.
 *
 * `webgpu-held-image-store.test.ts` pins the Babylon source shapes this relies
 * on; a runtime check falls back to copying if the main pass ever binds
 * anything but the owned texture.
 */

const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const RENDER_ATTACHMENT = 0x10;

type GpuTexture = { readonly width: number; readonly height: number; destroy(): void };
type GpuCommandEncoder = {
  copyTextureToTexture(source: { texture: GpuTexture }, destination: { texture: GpuTexture }, size: [number, number, number]): void;
  finish(): unknown;
};
type GpuDevice = {
  createTexture(descriptor: {
    label: string; size: [number, number, number]; format: string; usage: number;
    sampleCount: number; mipLevelCount: number; dimension: "2d";
  }): GpuTexture;
  createCommandEncoder(descriptor?: { label?: string }): GpuCommandEncoder;
  queue: { submit(commandBuffers: unknown[]): void };
  pushErrorScope?(filter: "validation"): void;
  popErrorScope?(): Promise<{ message: string } | null>;
};
type GpuCanvasConfiguration = { usage?: number } & Record<string, unknown>;
type GpuCanvasContext = { getCurrentTexture(): GpuTexture; configure(configuration: GpuCanvasConfiguration): void };

/** The WebGPUEngine members direct presentation replaces or reads. */
export type WebGpuPresentationInternals = AbstractEngine & {
  _device: GpuDevice;
  _context: GpuCanvasContext;
  _options: { antialias?: boolean; swapChainFormat?: string };
  _mainRenderPassWrapper: { colorAttachmentGPUTextures: Array<{ readonly underlyingResource?: unknown } | null | undefined> };
  _startMainRenderPass: (...args: unknown[]) => void;
  _configureContext: () => void;
};

/** The Engine's internals when they have the shape this store relies on, else null (presentation copies). */
export function webGpuPresentationInternals(engine: AbstractEngine): WebGpuPresentationInternals | null {
  if (!engine.isWebGPU) return null;
  const native = engine as AbstractEngine & Partial<WebGpuPresentationInternals>;
  const { _device: device, _context: context, _options: options } = native;
  if (typeof native._startMainRenderPass !== "function" || typeof native._configureContext !== "function") return null;
  if (typeof device?.createTexture !== "function" || typeof device.createCommandEncoder !== "function" || typeof device.queue?.submit !== "function") return null;
  if (typeof context?.getCurrentTexture !== "function" || typeof context.configure !== "function") return null;
  // MSAA renders into Babylon's own texture and resolves into the canvas; it keeps the copy path.
  if (!options || options.antialias || typeof options.swapChainFormat !== "string") return null;
  if (!Array.isArray(native._mainRenderPassWrapper?.colorAttachmentGPUTextures)) return null;
  if (typeof HTMLCanvasElement === "undefined" || !(engine.getRenderingCanvas() instanceof HTMLCanvasElement)) return null;
  return native as WebGpuPresentationInternals;
}

/** The WebGPU store, or null when this Engine's internals do not match (see `webGpuPresentationInternals`). */
export function createWebGpuHeldImageStore(engine: AbstractEngine): HeldImageStore | null {
  const native = webGpuPresentationInternals(engine);
  const canvas = engine.getRenderingCanvas();
  if (!native || !canvas) return null;
  const format = native._options.swapChainFormat!;
  const startMainRenderPass = native._startMainRenderPass;
  const configureContext = native._configureContext;
  const ownStart = Object.getOwnPropertyDescriptor(native, "_startMainRenderPass");
  const ownConfigure = Object.getOwnPropertyDescriptor(native, "_configureContext");
  /** The main pass draws into the target that does not hold the last coherent frame. */
  const targets: Array<GpuTexture | null> = [null, null];
  let held = -1;
  let owner: EngineView | null = null;
  let engaged = false;
  let drew = false;
  let usable = true;
  let copyChecked = false;
  let configuration = 0;
  /** What the canvas shows: a copy made at this canvas size and context configuration. */
  let shown: { width: number; height: number; configuration: number } | null = null;
  /** Replaced targets; passes of the current frame may still use them until it is submitted. */
  const retired: GpuTexture[] = [];
  const drawIndex = () => (held === 0 ? 1 : 0);
  const fail = (reason: string) => {
    if (!usable) return;
    usable = false;
    engaged = false;
    console.warn(`[render] WebGPU direct view presentation is off: ${reason}`);
  };
  const drawTarget = (): GpuTexture => {
    const index = drawIndex();
    const { width, height } = canvas;
    let target = targets[index];
    if (!target || target.width !== width || target.height !== height) {
      if (target) retired.push(target);
      target = native._device.createTexture({
        label: `DirectViewTarget${index}_${width}x${height}`, size: [width, height, 1], format,
        usage: RENDER_ATTACHMENT | COPY_SRC, sampleCount: 1, mipLevelCount: 1, dimension: "2d",
      });
      targets[index] = target;
    }
    return target;
  };
  const drawContext = { getCurrentTexture: drawTarget } as unknown as GpuCanvasContext;
  const directStart = function (this: WebGpuPresentationInternals, ...args: unknown[]): void {
    if (!engaged) return startMainRenderPass.apply(this, args);
    const context = this._context;
    this._context = drawContext;
    try { startMainRenderPass.apply(this, args); }
    finally { this._context = context; }
    // Babylon binds the texture it acquired; anything else means its internals moved.
    if (this._mainRenderPassWrapper.colorAttachmentGPUTextures[0]?.underlyingResource !== targets[drawIndex()])
      fail("the main pass did not render into the presentation target.");
    else drew = true;
  };
  const copyContext = function (this: WebGpuPresentationInternals): void {
    const context = this._context;
    // Presenting copies into the canvas texture.
    this._context = { configure: (configuration: GpuCanvasConfiguration) =>
      context.configure({ ...configuration, usage: (configuration.usage ?? RENDER_ATTACHMENT) | COPY_DST }) } as unknown as GpuCanvasContext;
    let configured = false;
    try { configureContext.call(this); configured = true; }
    catch { /* handled below */ }
    finally { this._context = context; }
    if (!configured) {
      fail("the canvas configuration changed shape.");
      configureContext.call(this);
    }
    configuration += 1;
  };
  const present = (source: GpuTexture) => {
    const destination = native._context.getCurrentTexture();
    const check = !copyChecked && typeof native._device.pushErrorScope === "function" && typeof native._device.popErrorScope === "function";
    if (check) native._device.pushErrorScope!("validation");
    const encoder = native._device.createCommandEncoder({ label: "DirectViewPresent" });
    encoder.copyTextureToTexture({ texture: source }, { texture: destination },
      [Math.min(source.width, destination.width), Math.min(source.height, destination.height), 1]);
    native._device.queue.submit([encoder.finish()]);
    if (check) {
      copyChecked = true;
      void native._device.popErrorScope!().then((error) => {
        if (error) fail(`the first copy to the canvas failed: ${error.message}`);
      }, () => {});
    }
    shown = { width: canvas.width, height: canvas.height, configuration };
  };
  const endFrame = engine.onEndFrameObservable.add(() => {
    for (const texture of retired.splice(0)) texture.destroy();
  });
  const drop = (destroy: boolean) => {
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      if (target && destroy) retired.push(target);
      targets[index] = null;
    }
    if (!destroy) retired.length = 0;
  };
  native._startMainRenderPass = directStart;
  native._configureContext = copyContext;
  native._configureContext();
  return {
    engage() {
      if (!usable) return;
      engaged = true;
      drew = false;
    },
    snapshot(view, width, height) {
      const index = drawIndex();
      const target = targets[index];
      if (!engaged || !drew || !target || target.width !== width || target.height !== height) return false;
      // Submit this frame's passes first: the copy reads what they drew.
      engine.flushFramebuffer();
      present(target);
      held = index;
      owner = view;
      return true;
    },
    restore(view, _width, _height, forRead = false) {
      const target = held >= 0 ? targets[held] : null;
      if (view !== owner || !target || !usable) return false;
      // Frames that did not acquire the canvas left it showing the held frame; a resize or a reconfiguration cleared it.
      const current = shown?.width === canvas.width && shown.height === canvas.height && shown.configuration === configuration;
      if (!current || forRead) present(target);
      return true;
    },
    size(view) {
      const target = held >= 0 ? targets[held] : null;
      return view === owner && target ? { width: target.width, height: target.height } : null;
    },
    release(view) {
      if (view !== owner) return;
      owner = null;
      held = -1;
    },
    clear(lost = false) {
      engaged = false;
      owner = null;
      held = -1;
      shown = null;
      drop(!lost);
    },
    usable: () => usable,
    dispose() {
      engaged = false;
      drop(true);
      for (const texture of retired.splice(0)) texture.destroy();
      engine.onEndFrameObservable.remove(endFrame);
      if (native._startMainRenderPass === directStart) {
        if (ownStart) Object.defineProperty(native, "_startMainRenderPass", ownStart);
        else Reflect.deleteProperty(native, "_startMainRenderPass");
      }
      if (native._configureContext === copyContext) {
        if (ownConfigure) Object.defineProperty(native, "_configureContext", ownConfigure);
        else Reflect.deleteProperty(native, "_configureContext");
      }
    },
  };
}

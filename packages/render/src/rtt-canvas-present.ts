import { Constants, NullEngine, RenderTargetTexture, type Scene } from "@babylonjs/core";
import { cssCanvasPixelSize, snapCanvasDrawingBuffer } from "./canvas-drawing-buffer";
import { flipReadPixelsRgba } from "./flip-read-pixels";

export type RttCanvasPresent = {
  /** Size the RTT from the canvas and assign `camera.outputRenderTarget`. */
  bind: () => void;
  /** Resolves after this RTT generation reaches the canvas; NullEngine has no pixels. */
  blit: () => Promise<void>;
  isPresenting: () => boolean;
  /** Assign bitmap size from CSS so a skipped blit stays blank, not stretched. */
  clear: () => void;
  dispose: () => void;
  canvasSize: () => { width: number; height: number };
  readbackMs: () => number | null;
};

/**
 * Present a Scene onto a 2D canvas via RTT so it does not steal the shared
 * Engine default framebuffer (Scene viewport / Play overlay).
 */
export function createRttCanvasPresent(
  scene: Scene,
  canvas: HTMLCanvasElement,
  options: { name?: string; maxSize?: number } = {},
): RttCanvasPresent {
  const name = options.name ?? "rttCanvas";
  const maxSize = options.maxSize ?? 2048;
  let rtt: RenderTargetTexture | null = null;
  let blitInFlight: Promise<void> | null = null;
  let generation = new AbortController();
  let disposed = false;
  let lastReadbackMs: number | null = null;

  const release = () => {
    disposed = true;
    generation.abort(new Error("RTT presentation was disposed."));
    const camera = scene.activeCamera;
    if (camera) camera.outputRenderTarget = null;
    rtt?.dispose();
    rtt = null;
  };

  const canvasSize = () => cssCanvasPixelSize(canvas);

  const bind = () => {
    if (disposed) return;
    const camera = scene.activeCamera;
    if (!camera) return;
    const rawW = Math.floor(canvas.clientWidth || 0);
    const rawH = Math.floor(canvas.clientHeight || 0);
    if (rawW <= 0 || rawH <= 0) return;
    const longest = Math.max(rawW, rawH);
    const scale = Math.min(1 / Math.max(1, scene.getEngine().getHardwareScalingLevel()), maxSize / longest);
    const width = Math.max(1, Math.floor(rawW * scale));
    const height = Math.max(1, Math.floor(rawH * scale));
    const current = rtt?.getSize();
    if (!rtt || current?.width !== width || current?.height !== height) {
      generation.abort(new Error("RTT presentation was superseded by a resize."));
      generation = new AbortController();
      camera.outputRenderTarget = null;
      rtt?.dispose();
      rtt = new RenderTargetTexture(
        name,
        { width, height },
        scene,
        false,
      );
      rtt.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
    }
    camera.outputRenderTarget = rtt;
  };

  const clear = () => {
    snapCanvasDrawingBuffer(canvas);
  };

  const blit = (): Promise<void> => {
    if (blitInFlight) return blitInFlight;
    if (disposed || !rtt || typeof canvas.getContext !== "function") return Promise.reject(new Error("The RTT presentation target is unavailable."));
    const texture = rtt;
    const signal = generation.signal;
    const work = (async () => {
      const start = performance.now();
      try {
        const buffer = await texture.readPixels();
        signal.throwIfAborted();
        if (!buffer) {
          if (scene.getEngine() instanceof NullEngine) return;
          throw new Error("The RTT presentation returned no pixels.");
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("The RTT presentation canvas is unavailable.");
        const { width, height } = texture.getSize();
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.putImageData(
          new ImageData(flipReadPixelsRgba(buffer, width, height), width, height),
          0,
          0,
        );
        lastReadbackMs = performance.now() - start;
      } catch (error) {
        lastReadbackMs = null;
        signal.throwIfAborted();
        // Native NullEngine cannot provide a GPU readback; it still tests RTT
        // ownership and cancellation. Real engines must not acknowledge failure.
        if (!(scene.getEngine() instanceof NullEngine)) throw error;
      }
    })();
    const pending = new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) reject(signal.reason);
    }).finally(() => { if (blitInFlight === pending) blitInFlight = null; });
    blitInFlight = pending;
    return pending;
  };

  return { bind, blit, isPresenting: () => blitInFlight !== null, clear, dispose: release, canvasSize, readbackMs: () => lastReadbackMs };
}

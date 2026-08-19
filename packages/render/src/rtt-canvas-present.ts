import { RenderTargetTexture, type Scene } from "@babylonjs/core";

export type RttCanvasPresent = {
  /** Size the RTT from the canvas and assign `camera.outputRenderTarget`. */
  bind: () => void;
  /** Best-effort 2D blit of the last RTT. NullEngine readback is a no-op. */
  blit: () => void;
  dispose: () => void;
  canvasSize: () => { width: number; height: number };
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
  let blitInFlight = false;

  const release = () => {
    const camera = scene.activeCamera;
    if (camera) camera.outputRenderTarget = null;
    rtt?.dispose();
    rtt = null;
  };

  const canvasSize = () => {
    const width = Math.floor(canvas.clientWidth || 0);
    const height = Math.floor(canvas.clientHeight || 0);
    return {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  };

  const bind = () => {
    const camera = scene.activeCamera;
    if (!camera) return;
    const rawW = Math.floor(canvas.clientWidth || 0);
    const rawH = Math.floor(canvas.clientHeight || 0);
    if (rawW <= 0 || rawH <= 0) return;
    const longest = Math.max(rawW, rawH);
    const scale = longest > maxSize ? maxSize / longest : 1;
    const width = Math.max(1, Math.floor(rawW * scale));
    const height = Math.max(1, Math.floor(rawH * scale));
    const current = rtt?.getSize();
    if (!rtt || current?.width !== width || current?.height !== height) {
      camera.outputRenderTarget = null;
      rtt?.dispose();
      rtt = new RenderTargetTexture(
        name,
        { width, height },
        scene,
        false,
      );
    }
    camera.outputRenderTarget = rtt;
  };

  const blit = () => {
    if (!rtt || blitInFlight || typeof canvas.getContext !== "function") return;
    blitInFlight = true;
    const texture = rtt;
    void (async () => {
      try {
        const buffer = await texture.readPixels();
        if (!buffer) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const { width, height } = texture.getSize();
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const bytes =
          buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer);
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(bytes), width, height),
          0,
          0,
        );
      } catch {
        // NullEngine / missing GPU readback is fine — tests assert the RTT.
      } finally {
        blitInFlight = false;
      }
    })();
  };

  return { bind, blit, dispose: release, canvasSize };
}

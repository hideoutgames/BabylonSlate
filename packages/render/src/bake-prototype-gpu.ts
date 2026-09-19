import type { WebGLRenderer, WebGLRenderTarget } from "three";

/** At most one submitted tile is in flight. Polling never blocks the authoring thread. */
export async function waitForBakeGpu(gl: WebGL2RenderingContext, checkpoint: () => Promise<void>): Promise<void> {
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!fence) throw new Error("Bake GPU fence allocation failed");
  try {
    gl.flush();
    for (;;) {
      await checkpoint();
      if (gl.isContextLost()) throw new Error("Bake WebGL context was lost");
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
      if (status !== gl.TIMEOUT_EXPIRED) throw new Error("Bake GPU completion wait failed");
    }
  } finally {
    gl.deleteSync(fence);
  }
}

/** Private-context PBO readback keeps cancellation usable until GPU completion. */
export async function readBakePixels(
  renderer: WebGLRenderer, target: WebGLRenderTarget, pixels: Float32Array, checkpoint: () => Promise<void>,
): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const previousTarget = renderer.getRenderTarget();
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Bake readback buffer allocation failed");
  try {
    renderer.setRenderTarget(target);
    // The job exclusively owns this context and no other operation uses pixel-pack buffers.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    renderer.setRenderTarget(previousTarget);
    await waitForBakeGpu(gl, checkpoint);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(buffer);
    renderer.setRenderTarget(previousTarget);
  }
}

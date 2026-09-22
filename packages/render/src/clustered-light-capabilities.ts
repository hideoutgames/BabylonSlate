import type { AbstractEngine } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

export type ClusteredLightCapabilities =
  | {
      supported: true;
      backend: "webgl2" | "webgpu";
      batchSize: number;
      maxTextureSize: number;
    }
  | { supported: false; reason: string };

const cached = new WeakMap<AbstractEngine, ClusteredLightCapabilities>();
const watched = new WeakSet<AbstractEngine>();

function requireNoErrors(gl: WebGL2RenderingContext, phase: string): void {
  const errors: number[] = [];
  for (let index = 0; index < 16; index++) {
    const error = gl.getError();
    if (error === gl.NO_ERROR) break;
    errors.push(error);
    if (error === gl.CONTEXT_LOST_WEBGL) break;
  }
  if (errors.length)
    throw new Error(
      `${phase}: ${errors.map((error) => `0x${error.toString(16)}`).join(", ")}`,
    );
}

/**
 * Cold-path WebGL2 probe for Babylon 9.20's R32F additive bit mask. Extension
 * flags alone do not establish the renderability, blending or integer precision
 * that the container requires. Restoring actual GL state leaves Engine caches
 * untouched, including when another Scene owns the current framebuffer.
 */
export function clusteredLightCapabilities(
  engine: AbstractEngine,
): ClusteredLightCapabilities {
  const previous = cached.get(engine);
  if (previous) return previous;
  if (!watched.has(engine)) {
    watched.add(engine);
    const restored = engine.onContextRestoredObservable.add(() =>
      cached.delete(engine),
    );
    engine.onDisposeObservable.addOnce(() => {
      engine.onContextRestoredObservable.remove(restored);
      cached.delete(engine);
      watched.delete(engine);
    });
  }
  let result: ClusteredLightCapabilities;
  if (engine.isWebGPU) {
    result = webgpuCapabilities(engine);
    cached.set(engine, result);
    return result;
  }
  try {
    // Pinned adapter: Babylon's public caps omit the context needed for this
    // numerical probe.
    const gl = (engine as AbstractEngine & { _gl?: WebGL2RenderingContext })
      ._gl;
    const caps = engine.getCaps();
    if (!gl?.createVertexArray || !caps.texelFetch)
      throw new Error("Clustered prototype requires WebGL2.");
    if (!caps.colorBufferFloat || !caps.blendFloat)
      throw new Error(
        "Float render targets and float blending are unavailable.",
      );
    const batchSize = engine.hostInformation.isMobile
      ? 8
      : caps.shaderFloatPrecision;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 24)
      throw new Error("Unsupported clustered float mask precision.");
    if (gl.isContextLost()) throw new Error("WebGL context is lost.");
    if (gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE))
      throw new Error(
        "Clustered admission requires an idle transform-feedback pass.",
      );
    // Pre-existing errors are reported separately, never mislabelled as a
    // failed float allocation or swallowed as successful capability evidence.
    requireNoErrors(gl, "Pre-existing WebGL errors before clustered admission");
    probeMask(gl, batchSize);
    result = {
      supported: true,
      backend: "webgl2",
      batchSize,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
  } catch (error) {
    result = {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  cached.set(engine, result);
  return result;
}

/**
 * WebGPU masks are exact u32 atomics in a storage buffer, so admission is a
 * device-limits check instead of the WebGL2 float-blend probe. The storage
 * buffer spans 64x64 tiles x 4 bytes per u32 word for every admitted batch
 * (Babylon 9.20's worst case is the full 32-batch budget).
 */
function webgpuCapabilities(engine: AbstractEngine): ClusteredLightCapabilities {
  try {
    if (!(engine instanceof WebGPUEngine))
      throw new Error("WebGPU clustered admission requires a WebGPUEngine.");
    const limits = engine.currentLimits;
    if ((limits?.maxStorageBuffersPerShaderStage ?? 0) < 1)
      throw new Error(
        "WebGPU clustered requires maxStorageBuffersPerShaderStage >= 1.",
      );
    if ((limits?.maxStorageBufferBindingSize ?? 0) < 64 * 64 * 32 * 4)
      throw new Error(
        "WebGPU clustered requires maxStorageBufferBindingSize >= 524288.",
      );
    const fragmentStage = (
      limits as { maxStorageBuffersInFragmentStage?: number } | undefined
    )?.maxStorageBuffersInFragmentStage;
    if (fragmentStage !== undefined && fragmentStage < 1)
      throw new Error(
        "WebGPU clustered requires maxStorageBuffersInFragmentStage >= 1.",
      );
    return {
      supported: true,
      backend: "webgpu",
      // Pinned to Babylon 9.20: ClusteredLightContainer._GetEngineBatchSize
      // returns 32 for WebGPU (u32 atomic words, one light per bit).
      batchSize: 32,
      maxTextureSize: engine.getCaps().maxTextureSize,
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeMask(gl: WebGL2RenderingContext, bits: number): void {
  const saved = {
    draw: gl.getParameter(
      gl.DRAW_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null,
    read: gl.getParameter(
      gl.READ_FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null,
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vao: gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null,
    texture: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
    pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null,
    unpack: gl.getParameter(
      gl.PIXEL_UNPACK_BUFFER_BINDING,
    ) as WebGLBuffer | null,
    packRowLength: gl.getParameter(gl.PACK_ROW_LENGTH) as number,
    packSkipRows: gl.getParameter(gl.PACK_SKIP_ROWS) as number,
    packSkipPixels: gl.getParameter(gl.PACK_SKIP_PIXELS) as number,
    viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
    color: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
    equationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number,
    equationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
    sourceRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    destinationRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    sourceAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    destinationAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
  };
  const toggles = [
    gl.BLEND,
    gl.DEPTH_TEST,
    gl.STENCIL_TEST,
    gl.SCISSOR_TEST,
    gl.CULL_FACE,
    gl.RASTERIZER_DISCARD,
    gl.SAMPLE_COVERAGE,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
  ].map((capability) => [capability, gl.isEnabled(capability)] as const);
  let texture: WebGLTexture | null = null;
  let target: WebGLFramebuffer | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  const shaders: WebGLShader[] = [];
  try {
    texture = gl.createTexture();
    target = gl.createFramebuffer();
    program = gl.createProgram();
    vao = gl.createVertexArray();
    if (!texture || !target || !program || !vao)
      throw new Error("Clustered capability probe allocation failed.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Clustered float framebuffer is incomplete.");
    const vertex = `#version 300 es
void main() { vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
    const fragment = `#version 300 es
precision highp float; uniform float bitValue; out float mask; void main() { mask=bitValue; }`;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Clustered probe shader allocation failed.");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          `Clustered probe shader failed: ${gl.getShaderInfoLog(shader) ?? "unknown error"}`,
        );
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(
        `Clustered probe link failed: ${gl.getProgramInfoLog(program) ?? "unknown error"}`,
      );
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.viewport(0, 0, 1, 1);
    for (const [capability] of toggles) gl.disable(capability);
    gl.colorMask(true, true, true, true);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array(4));
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    const uniform = gl.getUniformLocation(program, "bitValue");
    if (uniform === null)
      throw new Error("Clustered probe uniform is missing.");
    // All bits, including the highest supported bit, must survive addition.
    for (let bit = 0; bit < bits; bit++) {
      gl.uniform1f(uniform, 2 ** bit);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const pixel = new Float32Array(1);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.FLOAT, pixel);
    requireNoErrors(gl, "Clustered float render/blend probe");
    if (pixel[0] !== 2 ** bits - 1)
      throw new Error(
        `Clustered float blending lost mask precision (${pixel[0]}).`,
      );
  } finally {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
    gl.useProgram(saved.program);
    gl.bindVertexArray(saved.vao);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.pack);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpack);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, saved.packRowLength);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, saved.packSkipRows);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, saved.packSkipPixels);
    gl.bindTexture(gl.TEXTURE_2D, saved.texture);
    gl.viewport(
      saved.viewport[0]!,
      saved.viewport[1]!,
      saved.viewport[2]!,
      saved.viewport[3]!,
    );
    gl.colorMask(
      saved.color[0]!,
      saved.color[1]!,
      saved.color[2]!,
      saved.color[3]!,
    );
    gl.blendEquationSeparate(saved.equationRgb, saved.equationAlpha);
    gl.blendFuncSeparate(
      saved.sourceRgb,
      saved.destinationRgb,
      saved.sourceAlpha,
      saved.destinationAlpha,
    );
    for (const [capability, enabled] of toggles) {
      if (enabled) gl.enable(capability);
      else gl.disable(capability);
    }
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteProgram(program);
    gl.deleteVertexArray(vao);
    gl.deleteFramebuffer(target);
    gl.deleteTexture(texture);
  }
}

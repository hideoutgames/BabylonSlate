/**
 * Test-build-only readback of a Scene's shadow atlas: the exact depth bits of every texel of every page, digested per
 * page, so two runs or two builds can compare the shadow maps themselves (a frame can hide a shadow map difference).
 *
 * WebGL2 cannot read a depth attachment with `readPixels`, and the atlas samples with comparison. Each page is drawn
 * through a sampler object without comparison, a texel at a time (`texelFetch`), into an RGBA8 strip holding the four
 * bytes of its 32-bit depth, then read and digested strip by strip. Called between frames: the GL state it touches is
 * put back and Babylon's caches are wiped.
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";
import { shadowAtlasRenderTarget } from "@haptic/render/editor-proofs";

export type ShadowAtlasPageDigest = {
  /** SHA-256 of the page's depth bits, row by row from the bottom. */
  sha256: string;
  /** Texels holding something other than the far plane a clear leaves: a page that was drawn into. */
  written: number;
};

const STRIP_ROWS = 256;

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray atlas;
uniform int page;
uniform int firstRow;
out vec4 bytes;
void main() {
  uint bits = floatBitsToUint(texelFetch(atlas, ivec3(int(gl_FragCoord.x), int(gl_FragCoord.y) + firstRow, page), 0).r);
  bytes = vec4(float(bits & 255u), float((bits >> 8) & 255u), float((bits >> 16) & 255u), float(bits >> 24)) / 255.0;
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`atlas readback shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`atlas readback program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Each page of the Scene's atlas, digested; empty before its first tile. */
export async function readShadowAtlasPages(scene: Scene): Promise<ShadowAtlasPageDigest[]> {
  const wrapper = shadowAtlasRenderTarget(scene);
  const depth = wrapper?._depthStencilTexture;
  const texture = depth?._hardwareTexture?.underlyingResource as WebGLTexture | undefined;
  if (!depth || !texture) return [];
  const engine = scene.getEngine() as AbstractEngine & { _gl: WebGL2RenderingContext; wipeCaches(bruteForce?: boolean): void };
  const gl = engine._gl;
  const edge = depth.width, pages = depth.depth;
  const far = engine.useReverseDepthBuffer ? 0 : 0x3f800000;

  const saved = {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    unit: gl.getParameter(gl.ACTIVE_TEXTURE), viewport: gl.getParameter(gl.VIEWPORT), packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
  };
  gl.activeTexture(gl.TEXTURE0);
  const unit0 = {
    array: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY), plain: gl.getParameter(gl.TEXTURE_BINDING_2D), sampler: gl.getParameter(gl.SAMPLER_BINDING),
  };
  const capabilities = [gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD];
  const enabled = capabilities.map((capability) => gl.isEnabled(capability));
  const colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];

  const program = compile(gl);
  const vao = gl.createVertexArray();
  const sampler = gl.createSampler()!;
  gl.samplerParameteri(sampler, gl.TEXTURE_COMPARE_MODE, gl.NONE);
  gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const strip = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, strip);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, edge, STRIP_ROWS);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  const digests: ShadowAtlasPageDigest[] = [];
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, strip, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (const capability of capabilities) gl.disable(capability);
    gl.colorMask(true, true, true, true);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.bindSampler(0, sampler);
    gl.uniform1i(gl.getUniformLocation(program, "atlas"), 0);
    const pageAt = gl.getUniformLocation(program, "page"), rowAt = gl.getUniformLocation(program, "firstRow");
    const bytes = new Uint8Array(edge * STRIP_ROWS * 4);
    for (let page = 0; page < pages; page++) {
      gl.uniform1i(pageAt, page);
      const stripDigests: ArrayBuffer[] = [];
      let written = 0;
      for (let row = 0; row < edge; row += STRIP_ROWS) {
        const rows = Math.min(STRIP_ROWS, edge - row);
        gl.uniform1i(rowAt, row);
        gl.viewport(0, 0, edge, rows);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const view = bytes.subarray(0, edge * rows * 4);
        gl.readPixels(0, 0, edge, rows, gl.RGBA, gl.UNSIGNED_BYTE, view);
        const words = new Uint32Array(view.buffer, 0, edge * rows);
        for (const word of words) if (word !== far) written++;
        stripDigests.push(await crypto.subtle.digest("SHA-256", view));
      }
      const joined = new Uint8Array(stripDigests.length * 32);
      stripDigests.forEach((digest, index) => joined.set(new Uint8Array(digest), index * 32));
      digests.push({ sha256: hex(await crypto.subtle.digest("SHA-256", joined)), written });
    }
  } finally {
    gl.bindSampler(0, unit0.sampler);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, unit0.array);
    gl.bindTexture(gl.TEXTURE_2D, unit0.plain);
    gl.activeTexture(saved.unit);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.packBuffer);
    gl.bindVertexArray(saved.vao);
    gl.useProgram(saved.program);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
    gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
    capabilities.forEach((capability, index) => (enabled[index] ? gl.enable(capability) : gl.disable(capability)));
    gl.colorMask(colorMask[0]!, colorMask[1]!, colorMask[2]!, colorMask[3]!);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(strip);
    gl.deleteSampler(sampler);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    engine.wipeCaches(true);
  }
  return digests;
}

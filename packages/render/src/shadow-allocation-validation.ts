import type {
  AbstractEngine,
  InternalTexture,
  ShadowGenerator,
} from "@babylonjs/core";
import type { WebGLRenderTargetWrapper } from "@babylonjs/core/Engines/WebGL/webGLRenderTargetWrapper";

type ShadowGl = WebGLRenderingContext | WebGL2RenderingContext;

function readErrors(gl: ShadowGl): { errors: number[]; cleared: boolean } {
  const errors: number[] = [];
  // WebGL records a finite set of error flags. Bound the drain even if a lost
  // context or broken driver keeps reporting errors.
  for (let index = 0; index < 16; index++) {
    const error = gl.getError();
    if (error === gl.NO_ERROR) return { errors, cleared: true };
    errors.push(error);
    if (error === gl.CONTEXT_LOST_WEBGL) break;
  }
  return { errors, cleared: false };
}

function errorCodes(errors: number[]): string {
  return [...new Set(errors)]
    .map((error) => `0x${error.toString(16)}`)
    .join(", ");
}

function liveTexture(
  gl: ShadowGl,
  texture: InternalTexture | null,
  label: string,
): WebGLTexture {
  const resource = texture?._hardwareTexture
    ?.underlyingResource as WebGLTexture | null;
  if (!resource || !gl.isTexture(resource)) {
    throw new Error(`Shadow ${label} texture allocation is missing or invalid`);
  }
  return resource;
}

/**
 * Babylon 9.20 marks render-target InternalTextures ready without checking GL
 * allocation errors or framebuffer completeness. Run this only around a new
 * generator allocation, never during normal frame readiness checks.
 */
export function beginShadowAllocationValidation(
  engine: AbstractEngine,
): (generator: ShadowGenerator) => void {
  // Pinned WebGL adapter: AbstractEngine also supports NullEngine and WebGPU,
  // neither of which owns a WebGL context or WebGL attachment handles.
  const gl = (engine as AbstractEngine & { _gl?: ShadowGl })._gl;
  if (!gl) return () => {};
  const before = readErrors(gl);

  return (generator) => {
    const allocation = readErrors(gl);
    try {
      if (gl.isContextLost())
        throw new Error("Shadow allocation lost its WebGL context");
      if (before.cleared && allocation.errors.length > 0) {
        throw new Error(
          `Shadow allocation WebGL errors: ${errorCodes(allocation.errors)}`,
        );
      }
      if (generator.getLight().getScene().getEngine() !== engine) {
        throw new Error("Shadow allocation belongs to a different Engine");
      }
      const target = generator.getShadowMap()
        ?.renderTarget as WebGLRenderTargetWrapper | null;
      if (!target?._framebuffer || !gl.isFramebuffer(target._framebuffer)) {
        throw new Error("Shadow framebuffer allocation is missing or invalid");
      }
      const color = liveTexture(gl, target.texture, "color");
      const depth = target.depthStencilTexture
        ? liveTexture(gl, target.depthStencilTexture, "depth")
        : null;
      if (
        !depth &&
        (!target._depthStencilBuffer ||
          !gl.isRenderbuffer(target._depthStencilBuffer))
      ) {
        throw new Error(
          "Shadow depth attachment allocation is missing or invalid",
        );
      }
      const gl2 =
        "framebufferTextureLayer" in gl ? (gl as WebGL2RenderingContext) : null;
      if (target.is2DArray && !gl2) {
        throw new Error("Shadow array allocation requires WebGL2");
      }
      const slices = target.isCube ? 6 : target.is2DArray ? target.layers : 1;
      if (
        !Number.isInteger(slices) ||
        slices < 1 ||
        (target.is2DArray && slices > 4)
      ) {
        throw new Error("Shadow allocation has invalid cascade layers");
      }

      // A separate probe leaves the real target's lazy face/layer attachments
      // intact. Only framebuffer bindings change; Babylon's cached binding,
      // viewport, renderbuffer and texture state are never written.
      const drawBinding = gl.getParameter(
        gl2 ? gl2.DRAW_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING,
      ) as WebGLFramebuffer | null;
      const readBinding = gl2
        ? (gl2.getParameter(
            gl2.READ_FRAMEBUFFER_BINDING,
          ) as WebGLFramebuffer | null)
        : null;
      const bindingTarget = gl2 ? gl2.DRAW_FRAMEBUFFER : gl.FRAMEBUFFER;
      let probe: WebGLFramebuffer | null = null;
      const failures: unknown[] = [];
      try {
        probe = gl.createFramebuffer();
        if (!probe)
          throw new Error("Shadow validation framebuffer allocation failed");
        gl.bindFramebuffer(bindingTarget, probe);
        const depthAttachment =
          target.depthStencilTextureWithStencil || target._generateStencilBuffer
            ? gl.DEPTH_STENCIL_ATTACHMENT
            : gl.DEPTH_ATTACHMENT;
        if (!depth) {
          gl.framebufferRenderbuffer(
            bindingTarget,
            depthAttachment,
            gl.RENDERBUFFER,
            target._depthStencilBuffer,
          );
        }
        for (let slice = 0; slice < slices; slice++) {
          const attach = (attachment: number, texture: WebGLTexture) => {
            if (target.is2DArray && gl2) {
              gl2.framebufferTextureLayer(
                bindingTarget,
                attachment,
                texture,
                0,
                slice,
              );
            } else {
              const textureTarget = target.isCube
                ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + slice
                : gl.TEXTURE_2D;
              gl.framebufferTexture2D(
                bindingTarget,
                attachment,
                textureTarget,
                texture,
                0,
              );
            }
          };
          attach(gl.COLOR_ATTACHMENT0, color);
          if (depth) attach(depthAttachment, depth);
          const status = gl.checkFramebufferStatus(bindingTarget);
          if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(
              `Shadow framebuffer incomplete at slice ${slice}: 0x${status.toString(16)}`,
            );
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        const restore = [
          () => gl.bindFramebuffer(bindingTarget, drawBinding),
          ...(gl2
            ? [() => gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, readBinding)]
            : []),
          () => {
            if (probe) gl.deleteFramebuffer(probe);
          },
        ];
        for (const cleanup of restore) {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      const validation = readErrors(gl);
      // An uncleared pre-existing queue cannot identify newly raised errors.
      // Structural attachment/completeness checks still run in that case.
      if (allocation.cleared && validation.errors.length > 0) {
        failures.push(
          new Error(
            `Shadow validation WebGL errors: ${errorCodes(validation.errors)}`,
          ),
        );
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Shadow allocation validation or framebuffer restoration failed",
          { cause: failures[0] },
        );
      }
    } catch (error) {
      if (before.errors.length === 0) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}; pre-existing WebGL errors (excluded): ${errorCodes(before.errors)}`,
        { cause: error },
      );
    }
  };
}

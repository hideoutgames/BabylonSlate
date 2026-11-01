import { Constants } from "@babylonjs/core/Engines/constants";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { backbufferColorTextureHandle, type FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/** What decides whether a multisampled world view presents by one blit instead of a resolve and a copy. */
export interface MultisamplePresentInputs {
  /** A WebGL2 Engine (WebGPU resolves in the render pass itself). */
  webGl2: boolean;
  /** The view's own scene colour's samples. */
  samples: number;
  /** The own scene colour's texture type: a multisampled blit needs the backbuffer's format (RGBA8). */
  colorType: number;
  /** The output is the backbuffer, not a texture. */
  backbuffer: boolean;
  /** The own targets are the output's size: a multisampled blit cannot scale. */
  outputSized: boolean;
  /** Something after the objects pass reads or writes the scene colour (outlines, the water scene copy). */
  laterReaders: boolean;
}

/**
 * Whether the objects pass is the scene colour's last writer and nothing samples its resolve, so one
 * `blitFramebuffer` from the multisampled colour to the backbuffer replaces Babylon's resolve blit and the output copy.
 */
export function presentsMultisampleByBlit(inputs: MultisamplePresentInputs): boolean {
  return inputs.webGl2 && inputs.samples > 1 && inputs.colorType === Constants.TEXTURETYPE_UNSIGNED_BYTE &&
    inputs.backbuffer && inputs.outputSized && !inputs.laterReaders;
}

type GlEngine = AbstractEngine & { _gl?: WebGL2RenderingContext; _currentFramebuffer?: WebGLFramebuffer | null };
type MsaaHardware = { getMSAARenderBuffer?(index?: number): WebGLRenderbuffer | null };

/**
 * Resolves a multisampled colour target straight into the backbuffer: the source's multisampled renderbuffer is
 * attached to a read framebuffer this task owns, and blitted (NEAREST, same size) to the default framebuffer.
 */
export class MultisamplePresentTask extends FrameGraphTask {
  sourceTexture: FrameGraphTextureHandle | undefined;
  private framebuffer: WebGLFramebuffer | null = null;
  private renderbuffer: WebGLRenderbuffer | null = null;

  constructor(name: string, frameGraph: FrameGraph) {
    super(name, frameGraph);
  }

  override getClassName(): string {
    return "HapticMultisamplePresentTask";
  }

  override record(): void {
    if (this.sourceTexture === undefined) throw new Error(`${this.name}: sourceTexture is required`);
    const source = this.sourceTexture;
    // A render pass on the backbuffer, depending on the source: ordered after the objects pass, the source kept alive.
    const pass = this._frameGraph.addRenderPass(this.name);
    pass.addDependencies(source);
    pass.setRenderTarget(backbufferColorTextureHandle);
    pass.setExecuteFunc(() => {
      const engine = this._frameGraph.engine as GlEngine;
      const gl = engine._gl;
      const texture = this._frameGraph.textureManager.getTextureFromHandle(source);
      const renderbuffer = (texture?._hardwareTexture as MsaaHardware | null | undefined)?.getMSAARenderBuffer?.(0) ?? null;
      if (!gl || !texture || !renderbuffer) return;
      if (renderbuffer !== this.renderbuffer || !this.framebuffer) {
        if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
        this.framebuffer = gl.createFramebuffer();
        this.renderbuffer = renderbuffer;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
        gl.framebufferRenderbuffer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
      }
      // A blit passes only the pixel ownership and scissor tests: scissoring is lifted for it.
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, texture.width, texture.height, 0, 0, texture.width, texture.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
      // Babylon tracks the bound framebuffer itself: put back what it believes is bound.
      gl.bindFramebuffer(gl.FRAMEBUFFER, engine._currentFramebuffer ?? null);
    });
    const disabled = this._frameGraph.addRenderPass(this.name + "_disabled", true);
    disabled.setRenderTarget(backbufferColorTextureHandle);
    disabled.setExecuteFunc(() => {});
  }

  override dispose(): void {
    const gl = (this._frameGraph.engine as GlEngine)._gl;
    if (gl && this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    this.framebuffer = null;
    this.renderbuffer = null;
    super.dispose();
  }
}

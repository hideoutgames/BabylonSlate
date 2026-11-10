import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { EffectRenderer } from "@babylonjs/core/Materials/effectRenderer";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ThinImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/thinImageProcessingPostProcess";
import { retireOwnedEffect } from "./owned-effect-retirement";

/**
 * One full-screen pass that turns a colour target drawn with a view's own programs into the display-referred image a
 * capture stores: what each Material wrote itself when a capture drew it with image processing in the Material (the
 * Scene's own configuration, which stays at its defaults: encoded for display and clamped to 0..1).
 *
 * A Scene Linear view's programs write linear colour (`applyByPostProcess`), which the pass encodes (`linear`); any
 * other view's programs already write display colour, and the same stock shader then copies its input unchanged. So a
 * capture compiles no Material a second time, whatever the view's mode.
 */
export class DisplayConversion {
  private readonly engine: AbstractEngine;
  private readonly renderer: EffectRenderer;
  private pass: { linear: boolean; wrapper: ThinImageProcessingPostProcess } | null = null;

  constructor(engine: AbstractEngine) {
    this.engine = engine;
    this.renderer = new EffectRenderer(engine);
  }

  /** Whether the pass for a `linear` source is compiled; starts compiling it when not. */
  ready(linear: boolean): boolean {
    if (this.pass?.linear !== linear) {
      this.retire();
      // A dedicated configuration: the thin pass owns the one it is given (it sets and resets `applyByPostProcess`).
      const wrapper = new ThinImageProcessingPostProcess("Display conversion", this.engine, { imageProcessingConfiguration: new ImageProcessingConfiguration() });
      // The constructor compiles its linear form first; the other form orphans that Effect, released once it settles.
      const first = wrapper.effect;
      wrapper.fromLinearSpace = linear;
      if (first && first !== wrapper.effect) retireOwnedEffect(first, () => first.dispose());
      this.pass = { linear, wrapper };
    }
    return this.pass.wrapper.isReady();
  }

  /** Draws `source` into the bound framebuffer, over all of it. Only after `ready` answered true for its form. */
  draw(source: BaseTexture): void {
    const wrapper = this.pass!.wrapper;
    // The pass before may have drawn depth alone.
    this.engine.setColorWrite(true);
    this.renderer.setViewport();
    // Applying a post-process wrapper binds it: unblended, its quad at full scale, its configuration's values.
    this.renderer.applyEffectWrapper(wrapper);
    wrapper.effect.setTexture("textureSampler", source);
    this.renderer.draw();
  }

  private retire(): void {
    const pass = this.pass;
    this.pass = null;
    if (pass) retireOwnedEffect(pass.wrapper.effect, () => pass.wrapper.dispose());
  }

  dispose(): void {
    this.retire();
    this.renderer.dispose();
  }
}

import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { Color4, Constants } from "@babylonjs/core";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";

/** Pinned native task adapters; the caller's FrameGraph owns the attachments. */
export class LogicalGeometryTask extends FrameGraphGeometryRendererTask {
  private pass: FrameGraphRenderPass | undefined;

  override record(...args: Parameters<FrameGraphGeometryRendererTask["record"]>): FrameGraphRenderPass {
    this.pass = super.record(...args);
    return this.pass;
  }

  protected override _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[] {
    const layout = super._prepareRendering(context, depthEnabled);
    // Babylon 9.29 initializes MaxViewZ's clear color to zero. A sky pixel must
    // terminate a view-depth ray at the far plane, not at the camera origin.
    if (this.pass && this.textureDescriptions.some((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE)) {
      const far = Math.min(65000, this.camera?.maxZ || 65000);
      // Babylon 9.29 orders caller targets before the geometry textures.
      const targets = this.targetTexture === undefined ? 0 : Array.isArray(this.targetTexture) ? this.targetTexture.length : 1;
      const depth = new Array<boolean>(targets).fill(false)
        .concat(this.textureDescriptions.map((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE));
      // The base clear ends on the backbuffer. Rebind the geometry target: an
      // MRT layout on the backbuffer is a WebGL INVALID_OPERATION that fails
      // presentation and leaves the view depth uncleared.
      context.bindRenderTarget(this.pass.frameGraphRenderTarget);
      context.clearColorAttachments(new Color4(far, 0, 0, 1), this._frameGraph.engine.buildTextureLayout(depth));
      context.restoreDefaultFramebuffer();
    }
    return layout;
  }

  override isReady(): boolean {
    const ready = this.objectRenderer.customIsReadyFunction;
    // Native default refreshRate=1 probes only geometry, not its material.
    // Probe the actual MRT variant before the graph can acknowledge readiness.
    this.objectRenderer.customIsReadyFunction = (mesh, _rate, prewarm) =>
      this.dontRenderWhenMaterialDepthWriteIsDisabled && mesh.material?.disableDepthWrite
        ? !!prewarm : isMeshFrameReady(mesh);
    try { return withSceneReadinessState(this._frameGraph.scene, () => super.isReady()); }
    finally { this.objectRenderer.customIsReadyFunction = ready; }
  }

  protected override _checkTextureCompatibility(targets: FrameGraphTextureHandle[]): boolean {
    const depthEnabled = super._checkTextureCompatibility(targets);
    // Babylon 9.29 short-circuits its base compatibility method when explicit
    // depth is present. That also skips viewport dimensions, yielding no pixels.
    const target = targets[0] ?? this.depthTexture;
    if (target !== undefined) {
      const size = this._frameGraph.textureManager.getTextureDescription(target).size;
      this._textureWidth = size.width;
      this._textureHeight = size.height;
    }
    return depthEnabled;
  }
}

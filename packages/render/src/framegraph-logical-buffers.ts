import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { Color4, Constants } from "@babylonjs/core";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";

/** Pinned native task adapters; the caller's FrameGraph owns the attachments. */
export class LogicalGeometryTask extends FrameGraphGeometryRendererTask {
  protected override _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[] {
    const layout = super._prepareRendering(context, depthEnabled);
    // Babylon 9.20 initializes MaxViewZ's clear color to zero. A sky pixel must
    // terminate a view-depth ray at the far plane, not at the camera origin.
    if (this.textureDescriptions.some((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE)) {
      const far = Math.min(65000, this.camera?.maxZ || 65000);
      const depth = this.textureDescriptions.map((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE);
      if (this.targetTexture !== undefined) depth.push(...(Array.isArray(this.targetTexture) ? this.targetTexture : [this.targetTexture]).map(() => false));
      context.clearColorAttachments(new Color4(far, 0, 0, 1), this._frameGraph.engine.buildTextureLayout(depth));
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
    // Babylon 9.20 short-circuits its base compatibility method when explicit
    // depth is present. That also skips viewport dimensions, yielding no pixels.
    const target = targets[0] ?? this.depthTexture;
    if (target !== undefined) {
      const size = this._frameGraph.textureManager.getTextureDescription(target).size;
      this._textureWidth = size.width;
      this._textureHeight = size.height;
    }
    return depthEnabled;
  }

  override record(...args: Parameters<FrameGraphGeometryRendererTask["record"]>) {
    const previous = this._frameGraph.scene.needsPreviousWorldMatrices;
    try { return super.record(...args); }
    finally {
      // Depth/normal consumers must not switch off another owner's velocity.
      this._frameGraph.scene.needsPreviousWorldMatrices ||= previous;
    }
  }
}

import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";

/** Pinned native task adapters; the caller's FrameGraph owns the attachments. */
export class LogicalGeometryTask extends FrameGraphGeometryRendererTask {
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

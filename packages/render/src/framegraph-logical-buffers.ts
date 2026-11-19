import type { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { EngineCapabilities } from "@babylonjs/core/Engines/engineCapabilities";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphRenderPass } from "@babylonjs/core/FrameGraph/Passes/renderPass";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { readinessScanMeshes, requestCompilesAhead } from "./driver-compile";
import { drawGeometryDepthSeed, type GeometryDepthSeed } from "./geometry-depth-seed";
import { LightNeutralGeometryRendererTask } from "./light-neutral-tasks";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";

/**
 * Texture type for a geometry pass's view-depth attachment. Transparent meshes
 * draw into the geometry targets with blending on, and blending into a 32-bit
 * float target needs EXT_float_blend.
 * iPads lack it, so every such draw failed; half float always blends.
 */
export function geometryDepthTextureType(
  caps: Pick<EngineCapabilities, "textureFloatRender" | "textureHalfFloatRender" | "blendFloat">,
): number | undefined {
  if (caps.textureFloatRender && (caps.blendFloat || !caps.textureHalfFloatRender)) return Constants.TEXTURETYPE_FLOAT;
  return caps.textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : undefined;
}

/** Babylon 9.29's geometry clear colours by clear type (its module-private `ClearColors`; NoClear has none). */
const GEOMETRY_CLEAR_COLORS: readonly (Color4 | undefined)[] = [new Color4(0, 0, 0, 0), new Color4(1, 1, 1, 1), new Color4(0, 0, 0, 0)];
/** Babylon's `GeometryRenderingTextureClearType.MaxViewZ`: the view depth's. */
const MAX_VIEW_Z_CLEAR = 2;
const farColor = new Color4();

/** Babylon 9.29's attachment layouts of a geometry pass, built as it records. */
type GeometryClearLayouts = {
  /** Per clear type, the attachments it clears. */
  _clearAttachmentsLayout: Map<number, number[]>;
  /** The attachments the pass draws with. */
  _colorAttachmentsLayout: number[];
};

/**
 * Pinned native task adapters; the caller's FrameGraph owns the attachments.
 * Its attachments never depend on lighting, so it skips the per-pass light
 * flag toggles ([light-neutral-tasks](./light-neutral-tasks.ts)).
 */
export class LogicalGeometryTask extends LightNeutralGeometryRendererTask {
  private pass: FrameGraphRenderPass | undefined;
  /**
   * Set before the task records, on a pass whose only attachment is the view depth: the pass starts from the scene's
   * depth (`geometry-depth-seed.ts`) and its object list holds only the meshes that depth lacks.
   */
  seed: GeometryDepthSeed | undefined;
  /**
   * The pass clears its own depth as it starts, in its own render pass, instead of a clear task before it (a pass of
   * its own that stores the cleared depth for this one to load). A seeded pass needs no clear: its seed writes every
   * pixel's depth.
   */
  clearsDepth = false;
  /**
   * The pass discards its depth attachment once its draws end (`invalidateFramebuffer`), so a tile-based GPU need not
   * store it: set only where no later pass reads that depth (the spatial geometry pass's own, which every frame clears
   * or seeds again).
   */
  discardsDepth = false;

  constructor(...args: ConstructorParameters<typeof LightNeutralGeometryRendererTask>) {
    super(...args);
    this.objectRenderer.onFinishRenderingObservable.add(() => this.discardDepth());
  }

  override record(...args: Parameters<FrameGraphGeometryRendererTask["record"]>): FrameGraphRenderPass {
    this.pass = super.record(...args);
    if (this.seed) this.pass.addDependencies(this.seed.depth);
    return this.pass;
  }

  /**
   * Babylon's own preparation (`FrameGraphGeometryRendererTask._prepareRendering`) for a pass without the view depth.
   * One with it prepares once on its own target: each other clear type as Babylon clears it, then the view depth at
   * the far plane (Babylon 9.29 clears MaxViewZ to zero, but a sky pixel must terminate a view-depth ray at the far
   * plane, not at the camera origin) with the depth in the same clear, or the seed. The target stays bound for the
   * draws: Babylon's preparation ends on the backbuffer, so the pass would bind its target twice more.
   */
  protected override _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[] {
    const viewDepth = this.textureDescriptions.map((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE);
    if (!this.pass || !viewDepth.includes(true)) return super._prepareRendering(context, depthEnabled);
    const engine = this._frameGraph.engine;
    const layouts = this as unknown as GeometryClearLayouts;
    context.setDepthStates(this.depthTest && depthEnabled, this.depthWrite && depthEnabled);
    for (const [clearType, layout] of layouts._clearAttachmentsLayout)
      if (clearType !== MAX_VIEW_Z_CLEAR) context.clearColorAttachments(GEOMETRY_CLEAR_COLORS[clearType]!, layout);
    const far = Math.min(65000, this.camera?.maxZ || 65000);
    farColor.set(far, 0, 0, 1);
    // Babylon 9.29 orders caller targets before the geometry textures.
    const targets = this.targetTexture === undefined ? 0 : Array.isArray(this.targetTexture) ? this.targetTexture.length : 1;
    const depthLayout = engine.buildTextureLayout(new Array<boolean>(targets).fill(false).concat(viewDepth));
    if (this.seed) {
      context.clearColorAttachments(farColor, depthLayout);
      drawGeometryDepthSeed(context, engine, this.seed, this.camera, far);
    } else {
      // A clear honours the depth write mask.
      if (this.clearsDepth) engine.setDepthWrite(true);
      context.clearAttachments(farColor, depthLayout, true, this.clearsDepth, false);
    }
    // The seed's full-screen draw and the depth clear leave their own depth states: the meshes draw with the pass's.
    if (this.seed || this.clearsDepth) context.setDepthStates(this.depthTest && depthEnabled, this.depthWrite && depthEnabled);
    return layouts._colorAttachmentsLayout;
  }

  /** Discards the depth attachment (`discardsDepth`) while the pass's target is still bound, after its draws. */
  private discardDepth(): void {
    const engine = this._frameGraph.engine as AbstractEngine & { _gl?: WebGL2RenderingContext; _currentRenderTarget?: unknown };
    const gl = engine._gl;
    const target = this.pass?.frameGraphRenderTarget.renderTargetWrapper;
    if (!this.discardsDepth || !target || engine._currentRenderTarget !== target || typeof gl?.invalidateFramebuffer !== "function") return;
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  }

  /** Meshes this pass probed ahead of its readiness scan since it was last ready (`requestCompilesAhead`). */
  private readonly requestedAhead = new Set<AbstractMesh>();

  /**
   * Forget the meshes probed ahead, so the next scan probes them ahead again
   * and the pass keeps none alive: after a readiness invalidation, or when the
   * owner drops its object list.
   */
  forgetCompilesAhead(): void {
    this.requestedAhead.clear();
  }

  override isReady(): boolean {
    const ready = this.objectRenderer.customIsReadyFunction;
    // Native default refreshRate=1 probes only geometry, not its material.
    // Probe the actual MRT variant before the graph can acknowledge readiness.
    const probe = (mesh: AbstractMesh, prewarm?: boolean) =>
      this.dontRenderWhenMaterialDepthWriteIsDisabled && mesh.material?.disableDepthWrite
        ? !!prewarm : isMeshFrameReady(mesh);
    this.objectRenderer.customIsReadyFunction = (mesh, _rate, prewarm) => {
      if (probe(mesh, prewarm)) return true;
      // The scan stops here; a parallel-compile driver links the next meshes' variants meanwhile.
      requestCompilesAhead(this._frameGraph.engine, readinessScanMeshes(this.objectRenderer, this._frameGraph.scene), mesh,
        this.requestedAhead, (other) => probe(other, prewarm));
      return false;
    };
    try {
      // Probe the meshes even while the seed compiles, so their variants link meanwhile.
      const seeded = this.seed?.wrapper.isReady() ?? true;
      const done = withSceneReadinessState(this._frameGraph.scene, () => super.isReady()) && seeded;
      if (done) this.requestedAhead.clear();
      return done;
    } finally { this.objectRenderer.customIsReadyFunction = ready; }
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

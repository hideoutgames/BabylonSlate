import type {
  Camera,
  InternalTexture,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
} from "@babylonjs/core";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import type { FrameGraphShadowGeneratorTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/shadowGeneratorTask";
import { findSceneShadowController } from "./shadow-controller";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";
import { configureCutoutSorting } from "./sorting";

type BorrowedMap = {
  generator: ShadowGenerator;
  map: RenderTargetTexture;
  texture: InternalTexture;
  handle: FrameGraphTextureHandle;
};

/** Official object renderer with the pinned, protected shadow-binding hook exposed. */
export class ManagedShadowObjectRendererTask extends FrameGraphObjectRendererTask {
  constructor(...args: ConstructorParameters<typeof FrameGraphObjectRendererTask>) {
    super(...args);
    configureCutoutSorting(this._renderer);
    const renderer = this._renderer;
    const render = renderer.render;
    const scene = this._frameGraph.scene;
    renderer.render = (...renderArgs) => {
      const intermediate = scene._intermediateRendering;
      // Babylon 9.20 marks every graph ObjectRenderer as intermediate, even
      // its main scene pass. Mesh.ignoreCameraMaxZ must retain native main-pass
      // behavior; geometry and shadow passes keep their intermediate context.
      if (this.isMainObjectRenderer) scene._intermediateRendering = false;
      try { return render.apply(renderer, renderArgs); }
      finally { scene._intermediateRendering = intermediate; }
    };
  }

  private boundCamera: Camera | undefined;
  private boundShadows: Array<{
    generator: ShadowGenerator;
    enabled: boolean;
    shadowEnabled: boolean;
  }> = [];

  override isReady(): boolean {
    const previous = this._renderer.customIsReadyFunction;
    try {
      // Only override the readiness probe. Actual rendering keeps the official
      // renderer's readiness/cache behavior and any existing custom callback.
      this._renderer.customIsReadyFunction = (mesh, rate, preWarm) =>
        (!previous || previous(mesh, rate, preWarm)) && isMeshFrameReady(mesh);
      return super.isReady();
    } finally {
      this._renderer.customIsReadyFunction = previous;
    }
  }

  bindManagedShadows(
    generators: readonly ShadowGenerator[],
    camera: Camera,
  ): void {
    if (
      this.boundCamera === camera &&
      this.boundShadows.length === generators.length &&
      generators.every((generator, index) => {
        const previous = this.boundShadows[index];
        const light = generator.getLight();
        return (
          previous.generator === generator &&
          previous.enabled === light.isEnabled() &&
          previous.shadowEnabled === light.shadowEnabled
        );
      })
    )
      return;
    this.boundCamera = camera;
    this.boundShadows = generators.map((generator) => ({
      generator,
      enabled: generator.getLight().isEnabled(),
      shadowEnabled: generator.getLight().shadowEnabled,
    }));
    // Babylon 9.20 reads only these three members in _setLightsForShadow. Its
    // official shadow task cannot adopt a generator and owns disposal. Supplying
    // this narrow read contract avoids invoking any allocating task setters.
    // All controller generators (including CSM) currently use the null camera
    // key. The ordinary task class name preserves that key without adding a
    // second camera entry to the light's generator map.
    this.shadowGenerators = generators.map(
      (shadowGenerator) =>
        ({
          shadowGenerator,
          camera,
          getClassName: () => "FrameGraphShadowGeneratorTask",
        }) satisfies Pick<
          FrameGraphShadowGeneratorTask,
          "shadowGenerator" | "camera" | "getClassName"
        >,
    ) as FrameGraphShadowGeneratorTask[];
    this._setLightsForShadow();
  }
}

/** The prototype supports only allocations owned by this scene's controller. */
export function unsupportedManagedShadows(scene: Scene): string | undefined {
  const controller = findSceneShadowController(scene);
  for (const light of scene.lights) {
    for (const [camera, generator] of light.getShadowGenerators() ?? []) {
      const owned = controller?.generator(light);
      if (!owned || owned !== generator)
        return "Unmanaged shadow allocations require classic rendering.";
      if (camera !== null || owned.camera !== null)
        return "Camera-specific shadow allocations require classic rendering.";
      if (!generator.getShadowMap()?.getInternalTexture())
        return "The admitted shadow allocation is not ready for FrameGraph import.";
    }
  }
  return undefined;
}

/**
 * An ordered, external-resource bridge, not an allocator. The controller owns
 * generators, caster lists, refresh policy and disposal. FrameGraph only borrows
 * their textures; importing External resources never increments or releases the
 * Babylon texture reference count.
 */
export class ManagedShadowsTask extends FrameGraphTask {
  private borrowed: BorrowedMap[] = [];
  private recorded = false;
  private changedDuringFrame = false;
  private readonly scene: Scene;
  private readonly objects: ManagedShadowObjectRendererTask;

  constructor(
    graph: FrameGraph,
    scene: Scene,
    objects: ManagedShadowObjectRendererTask,
  ) {
    super("Forward admitted shadows", graph);
    this.scene = scene;
    this.objects = objects;
  }

  /** Allocation changes are rebuilt explicitly; compatible motion needs no build. */
  needsPreparation(): boolean {
    if (this.changedDuringFrame) return true;
    const current = this.generators();
    return (
      current.length !== this.borrowed.length ||
      current.some((generator, index) => {
        const previous = this.borrowed[index];
        return (
          previous.generator !== generator ||
          previous.map !== generator.getShadowMap() ||
          previous.texture !== generator.getShadowMap()?.getInternalTexture()
        );
      })
    );
  }

  private generators(): ShadowGenerator[] {
    const controller = findSceneShadowController(this.scene);
    const generators: ShadowGenerator[] = [];
    for (const light of this.scene.lights) {
      const generator = controller?.generator(light);
      if (generator) generators.push(generator);
    }
    return generators;
  }

  private bind(): void {
    const reason = unsupportedManagedShadows(this.scene);
    if (reason) throw new Error(reason);
    const current = this.generators();
    if (this.needsPreparation()) {
      const previous = this.borrowed;
      this.borrowed = current.map((generator) => {
        const map = generator.getShadowMap()!;
        const texture = map.getInternalTexture()!;
        const existing = previous.find(
          (entry) => entry.generator === generator && entry.texture === texture,
        );
        return (
          existing ?? {
            generator,
            map,
            texture,
            handle: this._frameGraph.textureManager.importTexture(
              `Admitted shadow ${generator.getLight().uniqueId}`,
              texture,
            ),
          }
        );
      });
      this.changedDuringFrame ||= this.recorded;
      this.objects.dependencies = new Set(
        this.borrowed.map((entry) => entry.handle),
      );
    }
    this.objects.bindManagedShadows(current, this.objects.camera);
  }

  override record(): void {
    this.bind();
    this.recorded = true;
    this._frameGraph.addPass(this.name).setExecuteFunc((context) => {
      // Babylon's graph scene path updates world matrices after the ordinary
      // target observable. Refresh again here, before consuming the RTT gate.
      findSceneShadowController(this.scene)?.refreshShadowMaps();
      // onBeforeRender can change admission after render's preflight. External
      // handles do not alias graph allocations: import the live maps, bind them
      // now, then request a fresh graph build on the following frame.
      this.bind();
      if (!this.scene.shadowsEnabled || !this.scene.renderTargetsEnabled)
        return;
      for (const entry of this.borrowed) {
        // A preceding caster draw can revoke a later light synchronously. Check
        // controller ownership before touching that later borrowed resource.
        if (!this.isCurrent(entry)) {
          this.changedDuringFrame = true;
          continue;
        }
        const { generator, map } = entry;
        const light = generator.getLight();
        if (!light.isEnabled() || !light.shadowEnabled || !map._shouldRender())
          continue;
        const engine = this.scene.getEngine();
        const target = engine._currentRenderTarget;
        const intermediate = this.scene._intermediateRendering;
        const stages = map._disableEngineStages;
        const depthTest = engine.getDepthBuffer();
        const depthWrite = engine.getDepthWrite();
        let failed = false;
        let failure: unknown;
        const errors: unknown[] = [];
        try {
          // Same pinned RTT stage switch as the official shadow task, borrowed
          // only for this draw so classic rendering retains its original state.
          map._disableEngineStages = true;
          context.setDepthStates(true, true);
          withSceneReadinessState(this.scene, () => {
            const output = this.objects.camera.outputRenderTarget?.renderTarget;
            if (output) {
              // CSM's before-bind hook reads the camera's cached projection.
              // Match Scene.render's output binding before computing cascades.
              engine.bindFramebuffer(output);
              this.scene.updateTransformMatrix(true);
            }
            context.renderUnmanaged(map);
          });
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          const restore = (action: () => void) => {
            try {
              action();
            } catch (error) {
              errors.push(error);
            }
          };
          restore(() => {
            map._disableEngineStages = stages;
          });
          restore(() => {
            this.scene._intermediateRendering = intermediate;
          });
          restore(() => engine.setDepthBuffer(depthTest));
          restore(() => engine.setDepthWrite(depthWrite));
          // renderUnmanaged lacks finally in 9.20. Restore the caller's target
          // even when a caster callback throws; never mask the original failure.
          restore(() => {
            if (engine._currentRenderTarget !== target) {
              if (target) engine.bindFramebuffer(target);
              else engine.restoreDefaultFramebuffer(true);
            }
          });
        }
        if (errors.length)
          throw new AggregateError(
            failed ? [failure, ...errors] : errors,
            "Managed shadow draw state restoration failed.",
          );
        if (failed) throw failure;
      }
      // Do not sample an allocation replaced during another shadow's callback.
      // It has not participated in this pass and needs fresh preparation.
      if (this.borrowed.some((entry) => !this.isCurrent(entry))) {
        this.changedDuringFrame = true;
        this.objects.bindManagedShadows(
          this.borrowed
            .filter((entry) => this.isCurrent(entry))
            .map((entry) => entry.generator),
          this.objects.camera,
        );
      }
    });
  }

  private isCurrent(entry: BorrowedMap): boolean {
    const light = entry.generator.getLight();
    return (
      findSceneShadowController(this.scene)?.generator(light) ===
        entry.generator &&
      entry.generator.getShadowMap() === entry.map &&
      entry.map.getInternalTexture() === entry.texture
    );
  }

  override isReady(): boolean {
    // isReadyForRendering does not consume _shouldRender; a readiness probe must
    // never turn a render-once map into an uninitialized cached allocation.
    for (const generator of this.generators()) {
      const map = generator.getShadowMap();
      if (
        !map ||
        !withSceneReadinessState(this.scene, () => map.isReadyForRendering())
      )
        return false;
    }
    return true;
  }

  override dispose(): void {
    this.borrowed = [];
    super.dispose();
  }
}

import type {
  AbstractMesh,
  Camera,
  InternalTexture,
  Light,
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
import { readinessScanMeshes, requestCompilesAhead } from "./driver-compile";
import { drawBorrowedTarget, type BorrowedDrawPolicy } from "./framegraph-borrowed-draw";
import { isMeshFrameReady, withSceneReadinessState } from "./scene-perf";
import { isRevealPending } from "./reveal-pending";
import { registerPipelineWarmPasses, warmRequestedPipelines } from "./variant-pipeline-warmup";
import { noteVariantSwap, variantSwapsTolerated } from "./variant-swaps";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { configureCutoutSorting } from "./sorting";
import { attachObjectRendererDepthPrePass, type TransparentDepthPrePass } from "./transparent-depth-pre-pass";

type BorrowedMap = {
  generator: ShadowGenerator;
  map: RenderTargetTexture;
  texture: InternalTexture;
};

/** A failed caster draw propagates as-is unless restoration also fails. */
const SHADOW_DRAW: BorrowedDrawPolicy = {
  restoreAlpha: false,
  wrapDrawFailure: false,
  message: "Managed shadow draw state restoration failed.",
};

/** Official object renderer with the pinned, protected shadow-binding hook exposed. */
export class ManagedShadowObjectRendererTask extends FrameGraphObjectRendererTask {
  /**
   * Draws part of the main view (such as the transparent half of a split
   * object pass) with main-pass semantics, without becoming the graph's
   * isMainObjectRenderer, which Babylon uses to find the frame's camera.
   */
  mainView = false;

  /**
   * Meshes this pass never draws (the water split draws copy-sampling water in its own pass): its readiness probe
   * leaves them to the pass that does, so no variant that nothing draws is compiled.
   */
  neverDraws: ((mesh: AbstractMesh) => boolean) | undefined;

  /** Transparent depth pre-passes draw under their own render pass id (see TransparentDepthPrePass). */
  private readonly depthPrePass: TransparentDepthPrePass;

  /**
   * A world view's main pass: after its real draws it draws the meshes its round asked to warm, so their next
   * variants' pipelines exist before a real draw needs them (`warmRequestedPipelines`).
   */
  get warmsPipelines(): boolean {
    return this.releaseWarmPasses !== undefined;
  }

  set warmsPipelines(value: boolean) {
    if (value === this.warmsPipelines) return;
    if (!value) {
      this.releaseWarmPasses?.();
      this.releaseWarmPasses = undefined;
      return;
    }
    this.releaseWarmPasses = registerPipelineWarmPasses(this._frameGraph.engine,
      [...this._renderer.renderPassIds, this.depthPrePass.renderPassId]);
  }

  private releaseWarmPasses: (() => void) | undefined;

  constructor(...args: ConstructorParameters<typeof FrameGraphObjectRendererTask>) {
    super(...args);
    configureCutoutSorting(this._renderer);
    const renderer = this._renderer;
    const render = renderer.render;
    const scene = this._frameGraph.scene;
    this.depthPrePass = attachObjectRendererDepthPrePass(scene, renderer);
    renderer.render = (...renderArgs) => {
      const intermediate = scene._intermediateRendering;
      // Babylon 9.29 marks every graph ObjectRenderer as intermediate, even
      // its main scene pass. Mesh.ignoreCameraMaxZ must retain native main-pass
      // behavior; geometry and shadow passes keep their intermediate context.
      if (this.isMainObjectRenderer || this.mainView) scene._intermediateRendering = false;
      try { return render.apply(renderer, renderArgs); }
      finally { scene._intermediateRendering = intermediate; }
    };
    // After the real draws and before the task restores its lights' shadow flags, so warm draws compile the variants
    // the real ones draw with.
    renderer.onAfterRenderingManagerRenderObservable.add(() => {
      if (!this.warmsPipelines) return;
      warmSafely(scene, () => warmRequestedPipelines(scene, scene.getEngine().currentRenderPassId, this.depthPrePass.renderPassId));
    });
  }

  /** This pass's render pass ids (its own and its blended depth pre-pass's), whose variants a prediction compiles. */
  get drawPasses(): number[] {
    return [...this._renderer.renderPassIds, this.depthPrePass.renderPassId];
  }

  /** Whether `renderPassId` is this pass's blended depth pre-pass, which draws with it every frame. */
  ownsRenderPass(renderPassId: number): boolean {
    return renderPassId === this.depthPrePass.renderPassId;
  }

  private readonly textureDependencies = new Map<
    string,
    readonly FrameGraphTextureHandle[]
  >();

  setOwnedTextureDependencies(
    owner: "shadows" | "clustered" | "water",
    handles: readonly FrameGraphTextureHandle[],
  ): void {
    const previous = this.textureDependencies.get(owner);
    if (
      previous?.length === handles.length &&
      handles.every((handle, index) => handle === previous[index])
    )
      return;
    this.textureDependencies.set(owner, [...handles]);
    this.dependencies = new Set([...this.textureDependencies.values()].flat());
  }

  private boundCamera: Camera | undefined;
  private boundShadows: Array<{
    generator: ShadowGenerator;
    light: Light;
    enabled: boolean;
    shadowEnabled: boolean;
  }> = [];

  /** Meshes this pass probed ahead of its readiness scan since it was last ready (`requestCompilesAhead`). */
  private readonly requestedAhead = new Set<AbstractMesh>();

  /** Forget the meshes probed ahead, so the next scan probes them ahead again: after a readiness invalidation. */
  forgetCompilesAhead(): void {
    this.requestedAhead.clear();
  }

  override isReady(): boolean {
    const previous = this._renderer.customIsReadyFunction;
    const engine = this._frameGraph.engine;
    const depthReady = (mesh: AbstractMesh) => this._renderer.disableDepthPrePass || this.depthPrePass.isReady(mesh);
    // Every variant this pass draws `mesh` with, the depth pre-pass even while the colour variant is unready.
    const probeAhead = (mesh: AbstractMesh, rate: number, preWarm?: boolean) => {
      if (previous && !previous(mesh, rate, preWarm)) return false;
      if (this.neverDraws?.(mesh) === true) return true;
      const colour = isMeshFrameReady(mesh);
      return depthReady(mesh) && colour;
    };
    try {
      // Only override the readiness probe. Actual rendering keeps the official
      // renderer's readiness/cache behavior and any existing custom callback.
      this._renderer.customIsReadyFunction = (mesh, rate, preWarm) => {
        if (previous && !previous(mesh, rate, preWarm)) return false;
        if (this.neverDraws?.(mesh) === true) return true;
        const colour = isMeshFrameReady(mesh);
        // A hidden mesh draws nothing yet, its depth pre-pass included; that probe notes whether its variant is ready
        // for the reveal.
        if (colour && isRevealPending(mesh)) {
          depthReady(mesh);
          return true;
        }
        if (colour && depthReady(mesh)) return true;
        // The scan stops here. A parallel-compile driver links this mesh's depth pre-pass, which an unready colour
        // variant holds back, and the next meshes' variants meanwhile.
        requestCompilesAhead(engine, readinessScanMeshes(this._renderer, this._frameGraph.scene), mesh, this.requestedAhead,
          (other) => probeAhead(other, rate, preWarm), colour ? undefined : depthReady);
        return false;
      };
      const ready = super.isReady();
      if (ready) this.requestedAhead.clear();
      return ready;
    } finally {
      this._renderer.customIsReadyFunction = previous;
    }
  }

  override dispose(): void {
    this.warmsPipelines = false;
    this.requestedAhead.clear();
    this.depthPrePass.dispose();
    super.dispose();
  }

  protected override _setLightsForShadow(): void {
    // Retain native generator binding, including its camera-key contract.
    super._setLightsForShadow();
    const admitted = new Set<Light>(this.shadowGenerators?.map((task) => task.shadowGenerator.getLight())
      .filter((light) => light.isEnabled() && light.shadowEnabled));
    const changed = new Map<Light, boolean>();
    this._renderer.onBeforeRenderObservable.remove(this._onBeforeRenderObservable);
    this._renderer.onAfterRenderObservable.remove(this._onAfterRenderObservable);
    this._onBeforeRenderObservable = this._renderer.onBeforeRenderObservable.add(() => {
      changed.clear();
      for (const light of this._scene.lights) {
        // With no map, the material already resolves to an unshadowed variant.
        // Native 9.29 toggles even these lights, dirtying every receiver twice
        // per pass despite identical shader output. Preserve their authored flag.
        if (!(light.getShadowGenerator(this.camera) ?? light.getShadowGenerator())) continue;
        const enabled = !this.disableShadows && admitted.has(light);
        if (light.shadowEnabled === enabled) continue;
        changed.set(light, light.shadowEnabled);
        light.shadowEnabled = enabled;
      }
    });
    this._onAfterRenderObservable = this._renderer.onAfterRenderObservable.add(() => {
      for (const [light, enabled] of changed) light.shadowEnabled = enabled;
      changed.clear();
    });
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
        // A pooled local map can move to another light without reallocating;
        // `admitted` must follow it or the object pass clears its shadows.
        return (
          previous.generator === generator &&
          previous.light === light &&
          previous.enabled === light.isEnabled() &&
          previous.shadowEnabled === light.shadowEnabled
        );
      })
    )
      return;
    this.boundCamera = camera;
    this.boundShadows = generators.map((generator) => ({
      generator,
      light: generator.getLight(),
      enabled: generator.getLight().isEnabled(),
      shadowEnabled: generator.getLight().shadowEnabled,
    }));
    // Babylon 9.29 reads only these three members in _setLightsForShadow. Its
    // official shadow task cannot adopt a generator and owns disposal. Supplying
    // this narrow read contract avoids invoking any allocating task setters.
    // Babylon re-registers each map under a camera key: the cascaded task's
    // camera, otherwise the null key. The scene view's maps keep the null key
    // through the ordinary task name; a view's own map (keyed to its camera)
    // reports the cascaded name and its camera, or it would replace the scene
    // view's null-key map and every other pass would bind the view's.
    this.shadowGenerators = generators.map(
      (shadowGenerator) =>
        ({
          shadowGenerator,
          camera: shadowGenerator.camera ?? camera,
          getClassName: () => shadowGenerator.camera ? "FrameGraphCascadedShadowGeneratorTask" : "FrameGraphShadowGeneratorTask",
        }) satisfies Pick<
          FrameGraphShadowGeneratorTask,
          "shadowGenerator" | "camera" | "getClassName"
        >,
    ) as FrameGraphShadowGeneratorTask[];
    this._setLightsForShadow();
  }
}

/**
 * The prototype supports only allocations owned by this scene's controller:
 * the scene view's maps (null camera key) and the views' own sun maps (keyed
 * to their camera, SceneShadowController.attachView).
 */
export function unsupportedManagedShadows(scene: Scene): string | undefined {
  const controller = findSceneShadowController(scene);
  for (const light of scene.lights) {
    for (const [camera, generator] of light.getShadowGenerators() ?? []) {
      const owned = camera === null ? controller?.boundGenerator(light) : controller?.viewBoundGenerator(light, camera);
      if (!owned || owned !== generator)
        return "Unmanaged shadow allocations are not supported.";
      if (owned.camera !== camera)
        return "Camera-specific shadow allocations are not supported.";
      if (!generator.getShadowMap()?.getInternalTexture())
        return "The admitted shadow allocation is not ready for FrameGraph import.";
    }
  }
  return undefined;
}

/**
 * An ordered, external-resource bridge, not an allocator. The controller owns
 * generators, caster lists, refresh policy and disposal. FrameGraph only borrows
 * their RTTs through renderUnmanaged. These textures are bound by the generator,
 * never by a graph texture handle. Ordered tasks retain the shadow-before-object
 * dependency without importing obsolete maps or rebuilding unrelated passes.
 */
export class ManagedShadowsTask extends FrameGraphTask {
  private borrowed: BorrowedMap[] = [];
  private readonly currentGenerators: ShadowGenerator[] = [];
  private recorded = false;
  private changedDuringFrame = false;
  private readonly scene: Scene;
  private readonly objects: ManagedShadowObjectRendererTask;
  /** Further main-view passes (a split object pass) that receive the same maps. */
  private readonly receivers: ManagedShadowObjectRendererTask[] = [];
  /**
   * An auxiliary view's camera (a Full Quality capture's). The view draws its
   * own sun maps, fitted to this camera (SceneShadowController.attachView),
   * and receives the scene view's point and spot maps as that view drew them:
   * it never walks casters, refits or refreshes them, so their render-once
   * caching and depth ranges stay the scene view's.
   */
  private readonly view: Camera | undefined;

  constructor(
    graph: FrameGraph,
    scene: Scene,
    objects: ManagedShadowObjectRendererTask,
    options: { view?: Camera } = {},
  ) {
    super("Forward admitted shadows", graph);
    this.scene = scene;
    this.objects = objects;
    this.view = options.view;
  }

  /** Bind another main-view pass to the admitted maps, before the graph builds. */
  addReceiver(task: ManagedShadowObjectRendererTask): void {
    if (task !== this.objects && !this.receivers.includes(task)) this.receivers.push(task);
  }

  private bindReceivers(generators: readonly ShadowGenerator[]): void {
    this.objects.bindManagedShadows(generators, this.objects.camera);
    for (const receiver of this.receivers) receiver.bindManagedShadows(generators, this.objects.camera);
  }

  /**
   * The shadow set changed since the last bind: a new probe binds it. Changed allocations need readiness, not new graph
   * tasks or render-pass IDs. Scene light order is irrelevant: a moved map keeps its allocation.
   */
  needsPreparation(current = this.generators()): boolean {
    if (this.changedDuringFrame) return true;
    return (
      current.length !== this.borrowed.length ||
      current.some((generator) => {
        const map = generator.getShadowMap();
        return !this.borrowed.some(
          (previous) =>
            previous.generator === generator &&
            previous.map === map &&
            previous.texture === map?.getInternalTexture(),
        );
      })
    );
  }

  /** Reused by every call; consumers copy it (borrowed, bound shadows). */
  private generators(): ShadowGenerator[] {
    const controller = findSceneShadowController(this.scene);
    const generators = this.currentGenerators;
    let count = 0;
    // Standby maps stay bound: receivers keep sampling them at neutral darkness.
    for (const light of this.scene.lights) {
      const generator = this.boundGenerator(controller, light);
      if (generator) generators[count++] = generator;
    }
    // Truncate after overwriting; clearing first would drop the backing store.
    generators.length = count;
    return generators;
  }

  /** The map this view's receivers bind for `light`. */
  private boundGenerator(controller: ReturnType<typeof findSceneShadowController>, light: Light): ShadowGenerator | null {
    return (this.view ? controller?.viewBoundGenerator(light, this.view) : controller?.boundGenerator(light)) ?? null;
  }

  private bind(): void {
    const reason = unsupportedManagedShadows(this.scene);
    if (reason) throw new Error(reason);
    const current = this.generators();
    if (this.needsPreparation(current)) {
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
          }
        );
      });
      this.changedDuringFrame ||= this.recorded;
    }
    this.bindReceivers(current);
  }

  override record(): void {
    this.bind();
    this.recorded = true;
    this._frameGraph.addPass(this.name).setExecuteFunc((context) => {
      // Babylon's graph scene path updates world matrices after the ordinary
      // target observable, so the controller skips its walk there (a graph
      // scene) and this is the frame's only one, before consuming the RTT gate.
      // A view draws inside the scene view's frame, after that walk.
      if (!this.view) findSceneShadowController(this.scene)?.refreshShadowMaps();
      // onBeforeRender can change admission after render's preflight. External
      // RTTs do not alias graph allocations: bind the live maps now, then warm
      // the changed receiver layout before the following presented frame.
      this.bind();
      if (!this.scene.shadowsEnabled || !this.scene.renderTargetsEnabled)
        return;
      for (const entry of this.borrowed) {
        // A view draws only its own maps; the scene view drew the shared ones.
        if (this.view && entry.generator.camera !== this.view) continue;
        // A preceding caster draw can revoke a later light synchronously. Check
        // controller ownership before touching that later borrowed resource.
        if (!this.isCurrent(entry)) {
          this.changedDuringFrame = true;
          continue;
        }
        const { generator, map } = entry;
        const light = generator.getLight();
        if (!light.isEnabled() || !light.shadowEnabled) continue;
        // A map that has not drawn yet first draws with every caster's depth variant ready, before its refresh is
        // consumed: a render-once map drawn without some casters would keep the gap. Until then it samples neutrally.
        if (awaitsFirstDraw(generator) && !withSceneReadinessState(this.scene, () => map.isReadyForRendering()))
          continue;
        if (!map._shouldRender()) continue;
        drawBorrowedTarget(
          this.scene,
          map,
          () => {
            context.setDepthStates(true, true);
            withSceneReadinessState(this.scene, () => {
              const output = this.objects.camera.outputRenderTarget?.renderTarget;
              if (output) {
                // CSM's before-bind hook reads the camera's cached projection,
                // whose aspect follows the bound target. Match Scene.render's
                // output binding before computing cascades.
                this.scene.getEngine().bindFramebuffer(output);
                this.scene.updateTransformMatrix(true);
              }
              context.renderUnmanaged(map);
            });
          },
          SHADOW_DRAW,
        );
      }
      // Do not sample an allocation replaced during another shadow's callback.
      // It has not participated in this pass and needs fresh preparation.
      if (this.borrowed.some((entry) => !this.isCurrent(entry))) {
        this.changedDuringFrame = true;
        this.bindReceivers(
          this.borrowed
            .filter((entry) => this.isCurrent(entry))
            .map((entry) => entry.generator),
        );
      }
    });
  }

  private isCurrent(entry: BorrowedMap): boolean {
    const light = entry.generator.getLight();
    return (
      this.boundGenerator(findSceneShadowController(this.scene), light) ===
        entry.generator &&
      entry.generator.getShadowMap() === entry.map &&
      entry.map.getInternalTexture() === entry.texture
    );
  }

  override isReady(): boolean {
    // A persistent graph can keep its maps while a light toggles shadows.
    // Install the current receiver binding before ObjectRenderer probes its
    // material variants; updating only at draw time warms the previous layout.
    this.bind();
    // isReadyForRendering does not consume _shouldRender; a readiness probe must
    // never turn a render-once map into an uninitialized cached allocation.
    for (const generator of this.generators()) {
      const map = generator.getShadowMap();
      if (!map) return false;
      // A probe binds the map, which refits the scene view's cascades to the
      // probing camera: a view probes only its own maps.
      if (this.view && generator.camera !== this.view) {
        if (!map.getInternalTexture()) return false;
        continue;
      }
      if (withSceneReadinessState(this.scene, () => map.isReadyForRendering())) continue;
      // A steady frame never waits for a caster's depth variant. A map that has not drawn yet samples neutrally (lit)
      // and draws on the first frame every caster is ready (`record`), as a swapping Material adopts its new variant;
      // a drawn map keeps drawing without the caster (Babylon skips it and redraws the map until it is ready, a
      // spawned or newly revealed caster). Every other probe waits for it.
      if (variantSwapsTolerated()) {
        noteVariantSwap();
        continue;
      }
      return false;
    }
    this.changedDuringFrame = false;
    return true;
  }

  override dispose(): void {
    this.borrowed = [];
    this.receivers.length = 0;
    super.dispose();
  }
}

/** Scenes whose warm draws failed once already: a failure repeats every frame, and is reported once. */
const warmFailures = new WeakSet<Scene>();

/**
 * Runs a pass's warm draws, which never end the pass early: Babylon's ObjectRenderer restores nothing when a draw
 * throws, and the task restores its lights' shadow flags after it, so a light holding a standby map would otherwise
 * stay unshadowed for good.
 */
function warmSafely(scene: Scene, warm: () => void): void {
  try {
    warm();
  } catch (error) {
    if (warmFailures.has(scene)) return;
    warmFailures.add(scene);
    console.warn(`[render] Pipeline warm draws failed: ${String(error)}`);
  }
}

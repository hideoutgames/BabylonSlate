import {
  BlurPostProcess,
  BloomMergePostProcess,
  Constants,
  ExtractHighlightsPostProcess,
  FxaaPostProcess,
  ImageProcessingPostProcess,
  Vector2,
  type Camera,
  type Effect,
  type PostProcess,
  type Scene,
} from "@babylonjs/core";
import { PostProcessRetirement } from "./post-process-retirement";
import { retireOwnedEffect } from "./owned-effect-retirement";
import {
  planSceneEffects,
  sceneEffectsImageProcessingConfiguration,
  sceneEffectsKey,
  type SceneEffectsPlan,
} from "./scene-effects";
import { sceneRenderingSettings } from "./render-settings";

function planFor(scene: Scene): SceneEffectsPlan | null {
  const state = sceneRenderingSettings(scene);
  return planSceneEffects(state.effects, state.mode, state.effectsEnabled);
}

function keyFor(scene: Scene): string {
  const state = sceneRenderingSettings(scene);
  return sceneEffectsKey(state.effects, state.mode, state.effectsEnabled);
}

/**
 * Settings-driven Display Color stage and display-space effects on a camera's
 * native post-process chain. The owner attaches and retires plain Babylon
 * passes; every retired effect still goes through the shared compile-guarded
 * retirement so a pending parallel compile can never drop its program early.
 *
 * The FrameGraph owner calls useGraph() when its own chain takes over; the
 * two consumers are mutually exclusive, like the authored stack owner.
 */
export class SceneEffectsOwner {
  private native: PostProcess[] | undefined;
  private nativeCamera: Camera | undefined;
  private nativeKey: string | undefined;
  private readonly retirement = new PostProcessRetirement();
  private disposed = false;
  private cleanupFailure: unknown;
  private resolveDisposed!: () => void;
  private readonly disposedSignal = new Promise<void>((resolve) => {
    this.resolveDisposed = resolve;
  });

  constructor(private readonly scene: Scene) {}

  /** Every currently attached native pass, for the coordinator's whitelist. */
  get passes(): PostProcess[] {
    return this.native ?? [];
  }

  /** Settings currently require an effect chain on this scene. */
  get hasEnabledEntries(): boolean {
    return planFor(this.scene) !== null;
  }

  /** The attached generation matches this camera and the live settings key. */
  nativeReadyFor(camera: Camera): boolean {
    return (
      !this.disposed &&
      this.nativeCamera === camera &&
      this.nativeKey === keyFor(this.scene)
    );
  }

  /** Attach (or rebuild) the native chain for the live settings on camera. */
  useNative(camera: Camera): void {
    if (this.disposed || camera.getScene() !== this.scene) return;
    const key = keyFor(this.scene);
    if (this.nativeCamera === camera && this.nativeKey === key) return;
    this.detachNative();
    this.nativeCamera = camera;
    this.nativeKey = key;
    const state = sceneRenderingSettings(this.scene);
    const plan = planSceneEffects(state.effects, state.mode, state.effectsEnabled);
    if (!plan) return;
    const engine = this.scene.getEngine();
    const passes: PostProcess[] = [];
    // Linear HDR keeps float intermediates until the display stage; Legacy
    // Display and CEL keep the established byte pipeline end to end.
    const type = plan.sceneLinear
      ? Constants.TEXTURETYPE_HALF_FLOAT
      : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    try {
      if (plan.bloom) {
        const scale = plan.bloom.scale;
        const extract = new ExtractHighlightsPostProcess(
          "Scene Effects Bloom Extract",
          scale,
          camera,
          Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
          engine,
          false,
          type,
          true,
        );
        extract.threshold = plan.bloom.threshold;
        // The kernel is relative to the full output size; blur passes run on
        // the scaled targets, matching the FrameGraph bloom composition.
        const kernel = Math.max(1, plan.bloom.kernel * scale);
        const blurX = new BlurPostProcess(
          "Scene Effects Bloom Blur X",
          new Vector2(1, 0),
          kernel,
          scale,
          camera,
          Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
          engine,
          false,
          type,
          undefined,
          true,
        );
        const blurY = new BlurPostProcess(
          "Scene Effects Bloom Blur Y",
          new Vector2(0, 1),
          kernel,
          scale,
          camera,
          Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
          engine,
          false,
          type,
          undefined,
          true,
        );
        passes.push(extract, blurX, blurY);
        passes.push(
          new BloomMergePostProcess(
            "Scene Effects Bloom Merge",
            extract,
            blurY,
            plan.bloom.weight,
            1,
            camera,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            engine,
            false,
            type,
            true,
          ),
        );
      }
      if (plan.imageProcessing) {
        const pass = new ImageProcessingPostProcess(
          "Scene Effects Display Color",
          1,
          camera,
          Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
          engine,
          false,
          type,
          sceneEffectsImageProcessingConfiguration(
            state.effects,
            plan.imageProcessing,
          ),
        );
        // A fromLinearSpace flip recompiles the pass; EffectWrapper overwrites
        // the prior Effect without releasing it, so retire the orphan.
        const previous = pass.getEffect();
        const references = previous?._refCount;
        pass.fromLinearSpace = plan.imageProcessing.sceneLinear;
        const current = pass.getEffect();
        if (
          previous &&
          (previous !== current || previous._refCount > references!)
        ) {
          this.retireOrphanedEffect(previous);
        }
        passes.push(pass);
      }
      if (plan.fxaa) {
        passes.push(
          new FxaaPostProcess(
            "Scene Effects FXAA",
            1,
            camera,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            engine,
            false,
            type,
          ),
        );
      }
    } catch (error) {
      for (const pass of passes.splice(0)) {
        try {
          this.retirePass(pass, camera);
        } catch {
          /* keep unwinding the rest */
        }
      }
      this.nativeCamera = undefined;
      this.nativeKey = undefined;
      throw error;
    }
    this.native = passes;
  }

  /** The graph chain now processes scene color; detach every native pass. */
  useGraph(): void {
    if (this.disposed) return;
    this.detachNative();
  }

  dispose(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.detachNative();
    } finally {
      this.resolveDisposed();
    }
  }

  /** Bounded CPU/native cleanup result; a rejection is not proof of release. */
  async whenDisposed(): Promise<void> {
    await this.disposedSignal;
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.retirement.whenDisposed();
  }

  /** Confirmed CPU/native release after every retired generation. */
  async whenReleased(): Promise<void> {
    await this.disposedSignal;
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.retirement.whenReleased();
  }

  private detachNative(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    const passes = this.native;
    const camera = this.nativeCamera;
    this.native = undefined;
    this.nativeCamera = undefined;
    this.nativeKey = undefined;
    if (!passes) return;
    try {
      for (const pass of passes) this.retirePass(pass, camera);
    } catch (error) {
      this.cleanupFailure = error;
      throw error;
    }
  }

  private retirePass(pass: PostProcess, camera: Camera | undefined): void {
    // Defer the native Effect refcount drop until a pending parallel compile
    // settles, then detach and release the pass. Thin-wrapped passes mark their
    // effect wrapper as externally owned (_useExistingThinPostProcess), so
    // PostProcess.dispose never touches it; retire the wrapper explicitly.
    const wrapper = (
      pass as unknown as { _effectWrapper?: { dispose(): void } }
    )._effectWrapper;
    const retirement = retireOwnedEffect(pass.getEffect() ?? null, () => {
      // Thin image processing recompiles whenever its configuration detaches;
      // disarm the observer so disposal cannot orphan a fresh Effect.
      const observed = wrapper as unknown as {
        _imageProcessingConfiguration?: {
          onUpdateParameters: { remove(observer: unknown): void };
        };
        _imageProcessingObserver?: unknown;
      };
      observed?._imageProcessingConfiguration?.onUpdateParameters.remove(
        observed?._imageProcessingObserver,
      );
      pass.dispose(camera);
      wrapper?.dispose();
    });
    this.track(retirement);
  }

  /** updateEffect overwrites the DrawWrapper's prior Effect unreferenced. */
  private retireOrphanedEffect(effect: Effect): void {
    this.track(retireOwnedEffect(effect, () => effect.dispose()));
  }

  private track(retirement: {
    completion: Promise<void>;
    released: Promise<void>;
  }): void {
    this.retirement.add({
      whenDisposed: () => retirement.completion,
      whenReleased: () => retirement.released,
    });
  }
}

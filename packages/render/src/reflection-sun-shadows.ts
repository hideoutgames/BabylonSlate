import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { enterDrawPass, leaveDrawPass, type DrawPass } from "./draw-passes";
import { sceneRenderingSettings } from "./render-settings";
import { findSceneShadowController, type ViewShadows } from "./shadow-controller";

/**
 * Renders of its owner a reflection that keeps sun maps of its own may go without drawing before it gives them back
 * (`ReflectionSunShadows.releaseIdle`): a mirror out of view holds no atlas tiles for long, and one glanced away from
 * does not rebuild them.
 */
const REFLECTION_SHADOW_IDLE_RENDERS = 120;

/** Whether `scene`'s planar reflections draw the sun's shadow from maps of their own (Reflection Shadows, shadows on). */
export function reflectionShadowsEnabled(scene: Scene): boolean {
  const shadows = sceneRenderingSettings(scene).shadows;
  return shadows.enabled && shadows.reflections;
}

/**
 * A planar reflection's own sun shadow (Reflection Shadows; a Mirror's or a planar water view's, one per mirror camera).
 * While the setting is on, the mirror camera holds the sun's cascades as maps of its own
 * (`SceneShadowController.attachView`), drawn just before its pass whenever they change (`drawViewMaps`), which its
 * receivers bind; while it is off, or while the atlas has no room for them, the reflection draws the sun unshadowed
 * (`sunShadowMap` in `haptic-lights.ts`). Spot and point light shadows do not depend on the view: every reflection
 * shows the scene view's.
 *
 * The mirror camera's frozen projection is oblique, its near plane the mirror plane, and Babylon's cascade fit splits
 * the camera's frustum between its near and far planes by its depth range: the slices would not be the view depths the
 * light block chooses cascades by. The maps fit, and follow changes, with the camera projecting through `fit` instead,
 * the ordinary perspective of the mirrored view the oblique projection was made from: the same side planes, so every
 * point the reflection shows is inside it, at the view depth its cascade is chosen by.
 */
export class ReflectionSunShadows {
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly oblique: Matrix;
  private claim: ViewShadows | null = null;
  /** Whether the last pass drew under Reflection Shadows, and with maps of its own. */
  private drawnOn = false;
  private drawnMaps = false;
  /** The owner's render of the last pass prepared. */
  private drawnAt = 0;

  /** `oblique` is the matrix the mirror camera's projection is frozen to (`PlanarMirrorTargetState.projection`). */
  constructor(scene: Scene, camera: Camera, oblique: Matrix) {
    this.scene = scene;
    this.camera = camera;
    this.oblique = oblique;
  }

  /** Whether the mirror camera claims sun maps of its own (they may be refused: `holdsMaps`). */
  get claimed(): boolean {
    return this.claim !== null;
  }

  /** Whether the mirror camera holds sun maps of its own now. */
  get holdsMaps(): boolean {
    return this.claim !== null && (findSceneShadowController(this.scene)?.viewHoldsMaps(this.camera) ?? false);
  }

  /**
   * Whether the reflection's last pass is out of date for its sun shadow: Reflection Shadows (`enabled`) changed since,
   * its maps came or went, or one would draw differently (`viewMapsDue`, which also refits them). Call with the mirror
   * camera placed for this render, `fit` the view's projection.
   */
  due(enabled: boolean, fit: Matrix): boolean {
    if (enabled !== this.drawnOn) return true;
    if (!enabled) return false;
    const controller = findSceneShadowController(this.scene);
    if (!controller) return this.drawnMaps;
    // Given back while idle: the next pass claims them again.
    if (!this.claim) return true;
    const maps = controller.viewHoldsMaps(this.camera);
    if (maps !== this.drawnMaps) return true;
    return maps && this.fitted(fit, () => controller.viewMapsDue(this.camera));
  }

  /**
   * Before the reflection's pass in the owner's render `tick`: claims its sun maps while Reflection Shadows is on, or
   * gives them back while it is off, and draws those that are due, into `pass`'s draw calls. Call as `due`.
   */
  prepare(enabled: boolean, fit: Matrix, pass: DrawPass, tick: number): void {
    this.drawnOn = enabled;
    this.drawnMaps = false;
    this.drawnAt = tick;
    if (!enabled) {
      this.release();
      return;
    }
    const controller = findSceneShadowController(this.scene);
    if (!controller) return;
    // Here, before the scene view's graph runs, as a capture claims its maps: a new map dirties lighting state.
    this.claim ??= controller.attachView(this.camera);
    if (!controller.viewHoldsMaps(this.camera)) return;
    this.drawnMaps = true;
    const engine = this.scene.getEngine();
    enterDrawPass(engine, pass, true);
    try {
      this.fitted(fit, () => controller.drawViewMaps(this.camera));
    } finally {
      leaveDrawPass(engine);
    }
  }

  /** Gives the maps back when the reflection has not drawn for `REFLECTION_SHADOW_IDLE_RENDERS` of its owner's renders. */
  releaseIdle(tick: number): void {
    if (this.claim && tick - this.drawnAt > REFLECTION_SHADOW_IDLE_RENDERS) this.release();
  }

  /** Gives the mirror camera's sun maps back: their tiles return to the atlas. */
  release(): void {
    const claim = this.claim;
    if (!claim) return;
    this.claim = null;
    // A disposal that throws is the controller's to report; the reflection draws unshadowed from now on.
    void claim.release().catch(() => {});
  }

  /** Runs `run` with the mirror camera projecting through `fit`, and its oblique projection back after. */
  private fitted<T>(fit: Matrix, run: () => T): T {
    const camera = this.camera;
    camera.freezeProjectionMatrix(fit);
    try {
      return run();
    } finally {
      camera.freezeProjectionMatrix(this.oblique);
      // Frustum planes computed while fitted are not the pass's.
      (camera as unknown as { _refreshFrustumPlanes: boolean })._refreshFrustumPlanes = true;
    }
  }
}

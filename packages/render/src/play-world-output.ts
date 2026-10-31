import {
  Camera,
  Constants,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  UniversalCamera,
  Vector3,
  type Mesh,
  type Observer,
} from "@babylonjs/core";
import { activeRenderFrameCapture } from "./render-frame-report";
import { isSceneFrameReady } from "./scene-perf";
import { PreparationTimedOut } from "./scene-render-coordinator";
import { SCENE_PREPARATION_CEILING_MS } from "./stall-deadline";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

/** The world's image over the whole backbuffer: its colour as drawn, opaque and without fog. */
const WORLD_OUTPUT_BLIT: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: false, role: "world" };

/** Play's two pixel sizes: the backbuffer Scene Layers draw into, and the world's own render size. */
export interface PlayOutputSizes {
  composition: { width: number; height: number };
  world: { width: number; height: number };
}

/**
 * Play's pixel sizes for a view of `view` pixels (CSS pixels, or a locked custom
 * resolution). The backbuffer is the full output, `view` × `pixelRatio` (the
 * device pixel ratio; 1 for a locked resolution). The world renders at `view` /
 * `worldLevel`, the hardware scaling level of the project's render scale,
 * dynamic resolution and Engine Settings, as it would without Scene Layers.
 */
export function playOutputSizes(
  view: { width: number; height: number },
  pixelRatio: number,
  worldLevel: number,
): PlayOutputSizes {
  const width = Math.max(1, Math.floor(view.width));
  const height = Math.max(1, Math.floor(view.height));
  // Divide by the level, as Babylon's view resize does, so both agree on every pixel.
  const scaled = (level: number) => ({
    width: Math.max(1, Math.floor(width / level)),
    height: Math.max(1, Math.floor(height / level)),
  });
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const level = Number.isFinite(worldLevel) && worldLevel > 0 ? worldLevel : 1;
  return { composition: scaled(1 / ratio), world: scaled(level) };
}

/**
 * Play's world image: the world Scene's active camera renders into this target
 * (its `outputRenderTarget`) at the world's render size, and `present` draws it
 * over the whole backbuffer before the Scene Layers. The world keeps its render
 * scale while the layers draw at the backbuffer's full resolution.
 */
export class PlayWorldOutput {
  private readonly scene: Scene;
  private target: RenderTargetTexture | null = null;
  private camera: Camera | null = null;
  private readonly blitScene: Scene;
  private readonly blitPlane: Mesh;
  private blitReady = false;
  private readonly cameraObserver: Observer<Scene>;

  constructor(scene: Scene) {
    this.scene = scene;
    const blitScene = new Scene(scene.getEngine());
    blitScene.autoClear = false;
    // The backbuffer's depth is never the world's: clear it so the full-view plane always draws.
    blitScene.autoClearDepthAndStencil = true;
    blitScene.skipPointerMovePicking = true;
    blitScene.lightsEnabled = false;
    const camera = new UniversalCamera("playWorldOutputCamera", new Vector3(0, 0, -1), blitScene);
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -1;
    camera.orthoRight = 1;
    camera.orthoTop = 1;
    camera.orthoBottom = -1;
    blitScene.activeCamera = camera;
    this.blitScene = blitScene;
    this.blitPlane = MeshBuilder.CreatePlane("playWorldOutputPlane", { size: 2 }, blitScene);
    this.cameraObserver = scene.onActiveCameraChanged.add(() => this.attach());
  }

  /** The world target's size, or null before the first `resize`. */
  size(): { width: number; height: number } | null {
    return this.target?.getSize() ?? null;
  }

  /** The world target, while one exists. */
  texture(): RenderTargetTexture | null {
    return this.target;
  }

  /** Sizes the world target, replacing it on a change, and attaches it to the active camera. */
  resize(width: number, height: number): void {
    const current = this.target?.getSize();
    if (this.target && current?.width === width && current.height === height) {
      this.attach();
      return;
    }
    const previous = this.target;
    this.detach();
    // The forward graph's output must be a single-sample colour and depth pair.
    const target = new RenderTargetTexture("playWorldOutput", { width, height }, this.scene, false, true);
    target.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
    this.target = target;
    previous?.dispose();
    this.blitReady = false;
    setUnlitMaterial(this.blitPlane, WORLD_OUTPUT_BLIT, {
      texture: target, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
    });
    this.attach();
  }

  /**
   * Gives the Scene's active camera the world target. A camera that draws its
   * own target (a Full Quality capture's, active only inside the world's frame)
   * keeps it, and the world camera keeps the world target meanwhile.
   */
  attach(): void {
    const camera = this.scene.activeCamera;
    const target = this.target;
    if (!camera || !target) return;
    if (camera.outputRenderTarget && camera.outputRenderTarget !== target) return;
    if (this.camera && this.camera !== camera && this.camera.outputRenderTarget === target)
      this.camera.outputRenderTarget = null;
    camera.outputRenderTarget = target;
    this.camera = camera;
  }

  /** Whether `present` can draw: the blit's Material is ready. */
  isReady(): boolean {
    if (!this.target) return false;
    if (!this.blitReady) this.blitReady = isSceneFrameReady(this.blitScene);
    return this.blitReady;
  }

  /**
   * Compiles the blit before the world's first frame needs it. `assertCurrent`
   * cancels; a blit that is still not ready at `SCENE_PREPARATION_CEILING_MS` rejects.
   */
  async prepare(assertCurrent: () => void): Promise<void> {
    const deadline = performance.now() + SCENE_PREPARATION_CEILING_MS;
    while (this.target && !this.isReady()) {
      assertCurrent();
      if (performance.now() >= deadline)
        throw new PreparationTimedOut(`Play world output preparation timed out after its ${SCENE_PREPARATION_CEILING_MS / 1000} s limit.`);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    assertCurrent();
  }

  /** Draws the world target over the whole backbuffer; false (nothing drawn) until it is ready. */
  present(): boolean {
    if (!this.isReady()) return false;
    const engine = this.scene.getEngine();
    const capture = activeRenderFrameCapture(engine);
    if (capture) capture.stage(this.blitScene, { name: "World output composition", kind: "composition" }, () => this.blitScene.render());
    else this.blitScene.render();
    return true;
  }

  dispose(): void {
    this.scene.onActiveCameraChanged.remove(this.cameraObserver);
    this.detach();
    this.target?.dispose();
    this.target = null;
    this.blitScene.dispose();
  }

  private detach(): void {
    if (this.camera && this.target && this.camera.outputRenderTarget === this.target)
      this.camera.outputRenderTarget = null;
    this.camera = null;
  }
}

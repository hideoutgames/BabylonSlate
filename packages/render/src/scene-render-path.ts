import {
  Camera,
  DirectionalLight,
  HemisphericLight,
  type Light,
  type Scene,
} from "@babylonjs/core";
import {
  resolveRenderingPipeline,
  type ClusteredRenderingAvailability,
  type ResolvedRenderingPipeline,
} from "@babylonslate/core";
import {
  ClusteredSceneLights,
  isClusterableLocalLight,
} from "./clustered-scene-lights";
import { clusteredLightCapabilities } from "./clustered-light-capabilities";
import { isManagedClusteredLight } from "./clustered-light-policy";
import { clusteredSceneMaterialReason } from "./clustered-material-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { sceneRenderingSettings } from "./render-settings";
import { findSceneShadowController } from "./shadow-controller";

const owners = new WeakMap<Scene, SceneRenderPath>();

function requested(
  scene: Scene,
  availability?: ClusteredRenderingAvailability,
): ResolvedRenderingPipeline {
  const state = sceneRenderingSettings(scene);
  return resolveRenderingPipeline(
    state.project,
    state.pathOverrides,
    undefined,
    undefined,
    { gpuBackend: scene.getEngine().isWebGPU ? "webgpu" : "webgl2" },
    availability,
  );
}

/** Read-only metadata. Renderer preparation resolves the actual capabilities first. */
export function sceneRenderPathStatus(scene: Scene): ResolvedRenderingPipeline {
  return owners.get(scene)?.status ?? requested(scene);
}

export function subscribeSceneRenderPath(
  scene: Scene,
  listener: (status: ResolvedRenderingPipeline) => void,
): () => void {
  const owner = ensureOwner(scene);
  owner.listeners.add(listener);
  listener(owner.status);
  return () => owner.listeners.delete(listener);
}

/** Settings/topology admission precedes shader readiness and the single rendering owner. */
export function syncSceneRenderPath(scene: Scene): void {
  if (scene.isDisposed) return;
  const state = sceneRenderingSettings(scene);
  if (
    !owners.has(scene) &&
    (state.pathOverrides.renderPath ??
      state.project.renderPath ??
      "forward") === "forward"
  )
    return;
  ensureOwner(scene).sync();
}

/** Called after the shared clustered policy has performed its live budget admission. */
export function publishSceneRenderPath(scene: Scene): void {
  owners.get(scene)?.publish();
}

function ensureOwner(scene: Scene): SceneRenderPath {
  let owner = owners.get(scene);
  if (!owner) {
    owner = new SceneRenderPath(scene);
    owners.set(scene, owner);
  }
  return owner;
}

class SceneRenderPath {
  readonly listeners = new Set<(status: ResolvedRenderingPipeline) => void>();
  status: ResolvedRenderingPipeline;
  private registry: Light[] = [];
  private cluster: ClusteredSceneLights | undefined;
  private selection: ResolvedRenderingPipeline;
  private syncing = false;
  private published = "";

  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    this.status = this.selection = requested(scene);
    scene.onDisposeObservable.addOnce(() => {
      this.cluster?.dispose();
      this.cluster = undefined;
      this.registry.length = 0;
      this.listeners.clear();
      owners.delete(scene);
    });
  }

  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const scene = this.scene;
      const preference = requested(scene);
      if (preference.requested.renderPath === "forward") {
        this.selection = preference;
        this.cluster?.dispose();
        this.cluster = undefined;
        this.registry.length = 0;
        return;
      }
      // Native borrowing removes children from scene.lights. Keep only this
      // owner's borrowed children plus current authored Scene membership.
      const live = new Set(scene.lights);
      const registry = this.registry.filter(
        (light) =>
          !light.isDisposed() &&
          (live.has(light) || this.cluster?.borrowsLight(light)),
      );
      const known = new Set(registry);
      for (const light of scene.lights) {
        if (
          !light.isDisposed() &&
          !known.has(light) &&
          !isManagedClusteredLight(scene, light)
        ) {
          registry.push(light);
          known.add(light);
        }
      }
      const changed =
        registry.length !== this.registry.length ||
        registry.some((light, index) => light !== this.registry[index]);
      this.registry = registry;
      this.selection = requested(scene, this.availability());
      if (this.selection.effective.renderPath === "clusteredForward") {
        if (!this.cluster)
          this.cluster = new ClusteredSceneLights(scene, registry);
        else if (changed) this.cluster.setLights(registry);
      } else if (this.cluster) {
        this.cluster.dispose();
        this.cluster = undefined;
      }
    } finally {
      this.syncing = false;
    }
  }

  publish(): void {
    if (this.syncing) return;
    const failure = this.cluster?.status().fallbackReason;
    this.status = failure
      ? requested(this.scene, { supported: false, reason: failure })
      : this.selection;
    const key = JSON.stringify(this.status);
    if (key === this.published) return;
    this.published = key;
    for (const listener of this.listeners) listener(this.status);
  }

  private availability(): ClusteredRenderingAvailability {
    const scene = this.scene;
    const capability = clusteredLightCapabilities(scene.getEngine());
    if (capability.supported === false) return capability;
    const camera = scene.activeCamera;
    if (
      !camera ||
      camera.getScene() !== scene ||
      camera.isDisposed() ||
      camera.mode !== Camera.PERSPECTIVE_CAMERA ||
      camera.minZ <= 0 ||
      !Number.isFinite(camera.maxZ) ||
      camera.maxZ <= camera.minZ
    )
      return {
        supported: false,
        reason:
          "Clustered Forward requires a perspective camera with a finite positive depth interval; using Forward.",
      };
    const reason = clusteredSceneMaterialReason(scene);
    if (reason) return { supported: false, reason };
    const shadows = findSceneShadowController(scene);
    const eligible = this.registry.filter(
      (light) =>
        isClusterableLocalLight(light) &&
        !shadows?.requestsShadow(light) &&
        !light.getShadowGenerators()?.size,
    ).length;
    const globals = this.registry.filter(
      (light) =>
        light instanceof DirectionalLight || light instanceof HemisphericLight,
    ).length;
    // Count authored structure, not positions, intensity, effective Enabled or
    // camera-selected shadow maps. Auto does not thrash on ordinary movement.
    const slots = Math.max(
      0,
      forwardLightBudget(scene.getEngine()).slots - globals,
    );
    const budget = sceneRenderingSettings(scene).localLightBudget;
    return {
      supported: true,
      autoEligible: Math.min(eligible, budget) > slots,
    };
  }
}

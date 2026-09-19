import {
  Mesh,
  MultiMaterial,
  type AbstractMesh,
  type Material,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import type { CelShadingOverrides, ShadowOverrides } from "@babylonslate/core";
import { CelMaterial, canUseCelMaterial } from "./cel-material";
import {
  sceneRenderingSettings,
  updateSceneRenderingSettings,
  type RenderShadingSettings,
} from "./render-settings";
import { isViewportShadingTarget } from "./viewport-shading-mode";
import { syncSceneLighting } from "./scene-lighting";
import { syncEnvironmentLighting } from "./environment-lighting";
import { markSceneReadinessDirty } from "./scene-perf";

const controllers = new WeakMap<Scene, () => void>();

/** Shared by world hosts and asset previews; CEL never mutates authored materials. */
export function setSceneRenderSettings(
  scene: Scene,
  project?: RenderShadingSettings,
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
): void {
  updateSceneRenderingSettings(scene, project, overrides, shadowOverrides);
  syncEnvironmentLighting(scene);
  let sync = controllers.get(scene);
  if (!sync) {
    const replacements = new Map<Material, Material>();
    const originals = new Map<Material, Material>();
    const resolved = new Map<Material, Material>();
    const settings = sceneRenderingSettings(scene);
    let appliedCel = false;
    // Set by the events that can change a resolved material; consumed by one
    // cheap before-render check so clean frames never scan scene.meshes.
    let dirty = false;
    let changed = false;
    // Material writes performed by sync itself must not re-mark it dirty.
    let writing = false;
    let lastDefaultMaterial: Material | null = scene.defaultMaterial;
    // Babylon notifies mesh/material additions asynchronously
    // (TimingTools.SetImmediate), so O(1) membership counts cover the window
    // between an add and its observable without scanning scene.meshes.
    let meshCount = scene.meshes.length;
    let materialCount = scene.materials.length;
    const meshObservers = new Map<Mesh, Observer<AbstractMesh>>();
    const requestSync = () => {
      if (!writing) dirty = true;
    };
    const watchMesh = (mesh: Mesh) => {
      if (meshObservers.has(mesh)) return;
      meshObservers.set(mesh, mesh.onMaterialChangedObservable.add(requestSync));
    };
    const unwatchMesh = (mesh: Mesh) => {
      const observer = meshObservers.get(mesh);
      if (observer === undefined) return;
      mesh.onMaterialChangedObservable.remove(observer);
      meshObservers.delete(mesh);
    };
    const resolve = (source: Material | null): Material | null => {
      if (!source) return null;
      if (originals.has(source)) source = originals.get(source)!;
      if (settings.mode !== "cel") return source;
      const cached = resolved.get(source);
      if (cached) return cached;
      let replacement = replacements.get(source);
      if (!replacement) {
        if (source instanceof MultiMaterial) {
          replacement = new MultiMaterial(`${source.name}:CEL`, scene);
        } else if (canUseCelMaterial(source)) {
          replacement = new CelMaterial(source, scene);
        } else return source;
        replacements.set(source, replacement);
        originals.set(replacement, source);
        const owned = replacement;
        source.onDisposeObservable.addOnce(() => {
          replacements.delete(source!);
          originals.delete(owned);
          owned.dispose(false, false);
        });
      }
      resolved.set(source, replacement);
      if (
        replacement instanceof MultiMaterial &&
        source instanceof MultiMaterial
      ) {
        const children = source.subMaterials.map(resolve);
        if (
          children.length !== replacement.subMaterials.length ||
          children.some(
            (child, index) => child !== replacement.subMaterials[index],
          )
        ) {
          replacement.subMaterials = children;
          changed = true;
        }
      } else if (replacement instanceof CelMaterial) replacement.syncSource();
      return replacement;
    };
    sync = () => {
      if (scene.isDisposed) return;
      const useCel = settings.mode === "cel";
      if (!useCel && !appliedCel) {
        // Nothing to replace in PBR mode, but keep the cheap change detectors
        // in step so the before-render check can settle clean again.
        lastDefaultMaterial = scene.defaultMaterial;
        meshCount = scene.meshes.length;
        materialCount = scene.materials.length;
        return;
      }
      appliedCel = useCel;
      changed = false;
      resolved.clear();
      writing = true;
      try {
        syncMaterials();
      } finally {
        writing = false;
      }
      lastDefaultMaterial = scene.defaultMaterial;
      meshCount = scene.meshes.length;
      materialCount = scene.materials.length;
      // Replacing default or assigned materials rebuilds their defines.
      if (changed) {
        markSceneReadinessDirty(scene);
        syncSceneLighting(scene);
      }
    };
    const syncMaterials = () => {
      const fallback = resolve(scene.defaultMaterial)!;
      if (fallback !== scene.defaultMaterial) {
        scene.defaultMaterial = fallback;
        changed = true;
        // Babylon's defaultMaterial setter does not reset the PBR/Standard
        // defines stored on meshes that inherit it (material === null).
        for (const mesh of scene.meshes) {
          if (mesh.material) continue;
          for (const subMesh of mesh.subMeshes ?? []) subMesh.resetDrawCache();
        }
        scene.resetCachedMaterial();
      }
      for (const mesh of scene.meshes) {
        if (
          !(mesh instanceof Mesh) ||
          !isViewportShadingTarget(mesh) ||
          !mesh.material
        )
          continue;
        // Attach here too: a mesh added between frames may assign its material
        // before the deferred onNewMeshAddedObservable observer runs.
        watchMesh(mesh);
        const next = resolve(mesh.material);
        if (next !== mesh.material) {
          mesh.material = next;
          changed = true;
        }
      }
    };
    controllers.set(scene, sync);
    // Event-driven: mesh/material membership and material assignment mark the
    // sync dirty; a `defaultMaterial` swap is caught by one identity compare
    // and adds/removes by the membership counts (the add observables are
    // deferred while removals notify synchronously).
    const meshAddedObserver = scene.onNewMeshAddedObservable.add((mesh) => {
      requestSync();
      if (mesh instanceof Mesh) watchMesh(mesh);
    });
    const meshRemovedObserver = scene.onMeshRemovedObservable.add((mesh) => {
      requestSync();
      if (mesh instanceof Mesh) unwatchMesh(mesh);
    });
    const materialAddedObserver =
      scene.onNewMaterialAddedObservable.add(requestSync);
    const materialRemovedObserver =
      scene.onMaterialRemovedObservable.add(requestSync);
    for (const mesh of scene.meshes) {
      if (mesh instanceof Mesh) watchMesh(mesh);
    }
    const observer = scene.onBeforeRenderObservable.add(() => {
      if (
        !dirty &&
        scene.defaultMaterial === lastDefaultMaterial &&
        scene.meshes.length === meshCount &&
        scene.materials.length === materialCount
      )
        return;
      dirty = false;
      sync!();
    });
    scene.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(observer);
      scene.onNewMeshAddedObservable.remove(meshAddedObserver);
      scene.onMeshRemovedObservable.remove(meshRemovedObserver);
      scene.onNewMaterialAddedObservable.remove(materialAddedObserver);
      scene.onMaterialRemovedObservable.remove(materialRemovedObserver);
      for (const mesh of meshObservers.keys()) unwatchMesh(mesh);
      for (const replacement of replacements.values())
        replacement.dispose(false, false);
      replacements.clear();
      originals.clear();
      resolved.clear();
      controllers.delete(scene);
    });
  }
  // Applying settings runs one immediate sync; the readiness cache is only
  // invalidated inside sync when a material/default/child list actually
  // changed, and lighting sync has its own change detection.
  sync!();
  syncSceneLighting(scene);
}

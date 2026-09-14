import {
  Mesh,
  MultiMaterial,
  type Material,
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
        )
          replacement.subMaterials = children;
      } else if (replacement instanceof CelMaterial) replacement.syncSource();
      return replacement;
    };
    sync = () => {
      if (scene.isDisposed) return;
      const useCel = settings.mode === "cel";
      if (!useCel && !appliedCel) return;
      appliedCel = useCel;
      resolved.clear();
      const fallback = resolve(scene.defaultMaterial)!;
      if (fallback !== scene.defaultMaterial) {
        scene.defaultMaterial = fallback;
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
        const next = resolve(mesh.material);
        if (next !== mesh.material) mesh.material = next;
      }
      syncSceneLighting(scene);
    };
    controllers.set(scene, sync);
    const observer = scene.onBeforeRenderObservable.add(sync);
    scene.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(observer);
      for (const replacement of replacements.values())
        replacement.dispose(false, false);
      replacements.clear();
      originals.clear();
      resolved.clear();
      controllers.delete(scene);
    });
  }
  sync();
}

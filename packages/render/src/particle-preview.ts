import {
  NodeMaterialModes,
  type Engine,
  type NodeMaterial,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import {
  createMaterialPreviewScene,
  type MaterialPreviewScene,
} from "./material-preview";
import {
  MaterialLibrary,
  materialUnavailable,
} from "./material-library";
import {
  createEngineDefaultCubeTexture,
  createSkyboxMesh,
} from "./skybox";

/**
 * Disposable particle Preview Scene on the app-lifetime Engine.
 *
 * Reuses the Material preview host (RTT + 2D blit, never a second Engine).
 * The preview primitive is hidden so only billboard quads are visible.
 */
export function createParticlePreviewScene(
  engine: Engine,
  options?: { skybox?: boolean },
): MaterialPreviewScene {
  const host = createMaterialPreviewScene(engine);
  host.mesh.isVisible = false;
  host.mesh.isPickable = false;
  if (options?.skybox) {
    createSkyboxMesh(
      host.scene,
      "particlePreviewSkybox",
      createEngineDefaultCubeTexture(host.scene),
    );
  }
  return host;
}

/** Compile particle-domain NodeMaterials for Preview `createEffectForParticles`. */
export function createParticleMaterialResolver(options: {
  scene: Scene;
  documents: ReadonlyMap<string, MaterialDocument>;
  functions?: ReadonlyMap<string, MaterialFunctionDocument>;
  resolveTexture?: (guid: string) => Texture | null;
}): {
  resolve: (guid: string) => NodeMaterial | null;
  dispose: () => void;
} {
  const library = new MaterialLibrary({
    resolveTexture: options.resolveTexture,
    functions: () =>
      Object.fromEntries(options.functions ?? new Map()),
  });
  const particleMaterial = (material: NodeMaterial): NodeMaterial | null =>
    material.mode === NodeMaterialModes.Particle ? material : null;
  return {
    resolve: (guid) => {
      const live = library.materialFor(options.scene, guid);
      if (live) return particleMaterial(live);
      const document = options.documents.get(guid);
      if (!document) return null;
      const acquired = library.acquire(options.scene, guid, document);
      if (materialUnavailable(acquired)) return null;
      return particleMaterial(acquired.material);
    },
    dispose: () => library.dispose(),
  };
}

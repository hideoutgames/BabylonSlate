import type { ResourceLease } from "./resource-cache";
import {
  type AbstractEngine,
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
import { MaterialLibrary } from "./material-library";
import { acquireParticleMaterial } from "./particle-material";
import type { ParticleMaterialOwner } from "./particle-service";
import { installPreviewEnvironment } from "./preview-environment";

/**
 * Disposable particle Preview Scene on the app-lifetime Engine.
 *
 * Reuses the Material preview host (RTT + 2D blit, never a second Engine).
 * The preview primitive is hidden so only billboard quads are visible.
 */
export function createParticlePreviewScene(
  engine: AbstractEngine,
  options?: { skybox?: boolean },
): MaterialPreviewScene {
  const host = createMaterialPreviewScene(engine);
  host.mesh.isVisible = false;
  host.mesh.isPickable = false;
  if (options?.skybox) {
    installPreviewEnvironment(host.scene);
  }
  return host;
}

/** Compile particle-domain NodeMaterials for Preview `createEffectForParticles`. */
export function createParticleMaterialResolver(options: {
  scene: Scene;
  documents: ReadonlyMap<string, MaterialDocument>;
  functions?: ReadonlyMap<string, MaterialFunctionDocument>;
  resolveTexture?: (guid: string) => Texture | null;
  acquireTexture?: (guid: string) => ResourceLease<Texture> | null;
}): {
  acquire: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null;
  dispose: () => void;
} {
  const library = new MaterialLibrary({
    resolveTexture: options.resolveTexture,
    acquireTexture: options.acquireTexture,
    functions: () =>
      Object.fromEntries(options.functions ?? new Map()),
  });
  return {
    acquire: (guid, owner) => {
      if (owner.scene !== options.scene) throw new Error("Particle preview material requested from another scene.");
      const document = options.documents.get(guid);
      if (!document) return null;
      return acquireParticleMaterial(library, guid, document, owner);
    },
    dispose: () => library.dispose(),
  };
}

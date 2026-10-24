import {
  NodeMaterial,
  PBRBaseMaterial,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type Matrix,
  type Mesh,
  type Nullable,
  type Scene,
  type SubMesh,
} from "@babylonjs/core";

/**
 * Per-mesh image-based lighting: a resolver names the environment cube a mesh
 * reflects (a reflection probe's), or null for the scene's own. PBR and Node
 * materials read `scene.environmentTexture` when they prepare defines and when
 * they bind, so both run with the mesh's cube in place: each submesh compiles
 * for its own cube's format and box projection, and binds its own cube.
 */
export type MeshEnvironmentResolver = (mesh: AbstractMesh) => BaseTexture | null;

const resolvers = new WeakMap<Scene, MeshEnvironmentResolver>();
/** The cube each material's uniforms last bound, so a switch forces a rebind. */
const lastBound = new WeakMap<Material, BaseTexture | null>();

type EnvironmentScene = Scene & { _environmentTexture: Nullable<BaseTexture> };
type ReadyForSubMesh = (this: Material, mesh: AbstractMesh, subMesh: SubMesh, useInstances?: boolean) => boolean;
type BindForSubMesh = (this: Material, world: Matrix, mesh: Mesh, subMesh: SubMesh) => void;

let installed = false;

/** Route `scene`'s PBR and Node materials through `resolver`; null restores scene-wide lighting. */
export function setMeshEnvironmentResolver(scene: Scene, resolver: MeshEnvironmentResolver | null): void {
  if (!resolver) { resolvers.delete(scene); return; }
  install();
  resolvers.set(scene, resolver);
}

/**
 * Pinned 9.29 adapter: swaps the scene's backing field, not its setter, which
 * would mark every material dirty on each draw.
 */
function withMeshEnvironment<T>(material: Material, mesh: AbstractMesh, run: () => T, bound?: (view: BaseTexture | null) => void): T {
  const scene = material.getScene() as EnvironmentScene;
  const resolver = resolvers.get(scene);
  if (!resolver) return run();
  const previous = scene._environmentTexture;
  const view = resolver(mesh) ?? previous;
  bound?.(view);
  if (view === previous) return run();
  scene._environmentTexture = view;
  try { return run(); } finally { scene._environmentTexture = previous; }
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const prototype of [PBRBaseMaterial.prototype, NodeMaterial.prototype] as unknown as Array<{ isReadyForSubMesh: ReadyForSubMesh; bindForSubMesh: BindForSubMesh }>) {
    const isReady = prototype.isReadyForSubMesh;
    const bind = prototype.bindForSubMesh;
    prototype.isReadyForSubMesh = function (mesh, subMesh, useInstances) {
      return withMeshEnvironment(this, mesh, () => isReady.call(this, mesh, subMesh, useInstances));
    };
    prototype.bindForSubMesh = function (world, mesh, subMesh) {
      withMeshEnvironment(this, mesh, () => bind.call(this, world, mesh, subMesh), (view) => {
        // Consecutive meshes sharing a material skip rebinding, and a frozen
        // material skips its uniform buffer: a different cube must rebind both.
        if (lastBound.get(this) === view) return;
        lastBound.set(this, view);
        if (subMesh._drawWrapper) subMesh._drawWrapper._forceRebindOnNextCall = true;
      });
    };
  }
}

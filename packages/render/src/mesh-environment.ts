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
/** Bumped when a resolved cube's bound values (its projection box) change in place. */
const revisions = new WeakMap<BaseTexture, number>();
/** The cube, and its revision, each material's uniforms last bound, so a switch or change forces a rebind. */
const lastBound = new WeakMap<Material, { view: BaseTexture | null; revision: number }>();

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

/** `view`'s box moved or resized: materials that bound it rebind its uniforms on their next draw, frozen ones included. */
export function markMeshEnvironmentChanged(view: BaseTexture): void {
  revisions.set(view, (revisions.get(view) ?? 0) + 1);
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
        // material skips its uniform buffer: a different or changed cube must rebind both.
        const revision = view ? revisions.get(view) ?? 0 : 0;
        const last = lastBound.get(this);
        if (last && last.view === view && last.revision === revision) return;
        // Shared materials can switch on many draws a frame: update the record in place.
        if (last) { last.view = view; last.revision = revision; } else lastBound.set(this, { view, revision });
        if (subMesh._drawWrapper) subMesh._drawWrapper._forceRebindOnNextCall = true;
      });
    };
  }
}

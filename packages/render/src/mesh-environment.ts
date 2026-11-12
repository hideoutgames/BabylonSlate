import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";

/**
 * Per-mesh image-based lighting: a resolver names the environment cube a mesh
 * reflects (a reflection probe's), or null for the scene's own. PBR and Node
 * materials read `scene.environmentTexture` when they prepare defines and when
 * they bind, so both run with the mesh's cube in place: each submesh compiles
 * for its own cube's format and box projection, and binds its own cube.
 */
type MeshEnvironmentResolver = (mesh: AbstractMesh) => BaseTexture | null;

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
 * Consecutive meshes sharing a material skip rebinding, and a frozen material skips its uniform buffer: a different or
 * changed cube must rebind both.
 */
function noteBoundView(material: Material, view: BaseTexture | null, subMesh: SubMesh): void {
  const revision = view ? revisions.get(view) ?? 0 : 0;
  const last = lastBound.get(material);
  if (last && last.view === view && last.revision === revision) return;
  // Shared materials can switch on many draws a frame: update the record in place.
  if (last) { last.view = view; last.revision = revision; } else lastBound.set(material, { view, revision });
  if (subMesh._drawWrapper) subMesh._drawWrapper._forceRebindOnNextCall = true;
}

/**
 * Pinned 9.29 adapter: each wrapper resolves the mesh's cube and runs the original with it in the scene's backing
 * field, not its setter, which would mark every material dirty on each draw. Written out in both wrappers so a draw
 * allocates no closure.
 */
function install(): void {
  if (installed) return;
  installed = true;
  for (const prototype of [PBRBaseMaterial.prototype, NodeMaterial.prototype] as unknown as Array<{ isReadyForSubMesh: ReadyForSubMesh; bindForSubMesh: BindForSubMesh }>) {
    const isReady = prototype.isReadyForSubMesh;
    const bind = prototype.bindForSubMesh;
    prototype.isReadyForSubMesh = function (mesh, subMesh, useInstances) {
      const scene = this.getScene() as EnvironmentScene;
      const resolver = resolvers.get(scene);
      if (!resolver) return isReady.call(this, mesh, subMesh, useInstances);
      const previous = scene._environmentTexture;
      const view = resolver(mesh) ?? previous;
      if (view === previous) return isReady.call(this, mesh, subMesh, useInstances);
      scene._environmentTexture = view;
      try { return isReady.call(this, mesh, subMesh, useInstances); } finally { scene._environmentTexture = previous; }
    };
    prototype.bindForSubMesh = function (world, mesh, subMesh) {
      const scene = this.getScene() as EnvironmentScene;
      const resolver = resolvers.get(scene);
      if (!resolver) { bind.call(this, world, mesh, subMesh); return; }
      const previous = scene._environmentTexture;
      const view = resolver(mesh) ?? previous;
      noteBoundView(this, view, subMesh);
      if (view === previous) { bind.call(this, world, mesh, subMesh); return; }
      scene._environmentTexture = view;
      try { bind.call(this, world, mesh, subMesh); } finally { scene._environmentTexture = previous; }
    };
  }
}

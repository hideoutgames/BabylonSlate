import type { AbstractMesh, Material } from "@babylonjs/core";

/**
 * Run `bind`, which may assign several Materials to the same meshes in turn (a
 * model's slot Material, then the component's override, then a saved instance),
 * so that observers of `onMaterialChangedObservable` hear only the net result:
 * one notification for a mesh that ended on a different Material, none for a
 * mesh that ended where it started. The assignments themselves still happen in
 * order, so every writer reads the state its predecessor left. Without this,
 * an unchanged actor announced a Material change on every apply, and each one
 * made the renderer re-probe every shader variant.
 */
export function withNetMaterialChanges<T>(meshes: Iterable<AbstractMesh>, bind: () => T): T {
  const held: Array<{ mesh: AbstractMesh; start: Material | null }> = [];
  for (const mesh of meshes) {
    const observable = mesh.onMaterialChangedObservable as { notifyObservers?: unknown };
    // An enclosing bind already holds this mesh and reports for it.
    if (Object.hasOwn(observable, "notifyObservers")) continue;
    observable.notifyObservers = () => true;
    held.push({ mesh, start: mesh.material });
  }
  try {
    return bind();
  } finally {
    for (const { mesh } of held) delete (mesh.onMaterialChangedObservable as { notifyObservers?: unknown }).notifyObservers;
    for (const { mesh, start } of held) {
      if (!mesh.isDisposed() && mesh.material !== start) mesh.onMaterialChangedObservable.notifyObservers(mesh);
    }
  }
}

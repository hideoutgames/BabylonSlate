import type { AbstractMesh, InstancedMesh, Mesh } from "@babylonjs/core";

/**
 * A regular instance draws in its source's batch, with its source's submeshes, Effects and pipelines: the source is
 * its readiness unit. A leaf module (type imports only), for the probes and warm-ups that resolve an instance.
 */
export function drawingMesh(mesh: AbstractMesh): AbstractMesh {
  return mesh.getClassName() === "InstancedMesh" ? (mesh as InstancedMesh).sourceMesh : mesh;
}

const instanceSources = new WeakSet<Mesh>();

/** Marks `mesh` a source that only draws its instances (hidden, never drawn plain): it compiles its instanced variants only. */
export function markInstanceSource(mesh: Mesh): void {
  instanceSources.add(mesh);
}

/** Whether `mesh` is marked a source that only draws its instances (`markInstanceSource`). */
export function isInstanceSource(mesh: Mesh): boolean {
  return instanceSources.has(mesh);
}

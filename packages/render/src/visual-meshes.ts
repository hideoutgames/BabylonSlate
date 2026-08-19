import type { AbstractMesh, Material } from "@babylonjs/core";

const CONSTRUCTION_KEY = "babylonslateModelConstructionMaterial";

type ConstructionMeta = {
  [CONSTRUCTION_KEY]?: Material | null;
};

function asMeta(mesh: AbstractMesh): ConstructionMeta {
  const current =
    mesh.metadata && typeof mesh.metadata === "object"
      ? (mesh.metadata as ConstructionMeta)
      : {};
  mesh.metadata = current;
  return current;
}

function hasGeometry(mesh: AbstractMesh): boolean {
  return mesh.getTotalVertices() > 0;
}

/**
 * Drawn glTF parts under a hidden placeholder. Skip the stub and empty
 * `__root__` meshes so slot 0 is the first real primitive.
 */
export function visualMeshes(root: AbstractMesh): AbstractMesh[] {
  const children = root.getChildMeshes().filter(hasGeometry);
  if (root.visibility === 0 && children.length > 0) {
    return children;
  }
  if (hasGeometry(root)) {
    return [root, ...children.filter((mesh) => mesh !== root)];
  }
  return children;
}

export function applyMaterialToVisualMeshes(
  root: AbstractMesh,
  material: Material | null,
): void {
  for (const mesh of visualMeshes(root)) {
    mesh.material = material;
  }
}

export function constructionMaterialOf(mesh: AbstractMesh): Material | null {
  const meta = asMeta(mesh);
  if (!Object.prototype.hasOwnProperty.call(meta, CONSTRUCTION_KEY)) {
    meta[CONSTRUCTION_KEY] = mesh.material ?? null;
  }
  return meta[CONSTRUCTION_KEY] ?? null;
}

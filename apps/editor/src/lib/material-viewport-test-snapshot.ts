import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";

export type MaterialViewportTestSnapshot = {
  meshUniqueId: number;
  materialUniqueId: number | null;
  materialInputs: Record<string, number[]>;
};

/** Read the live assigned shader; called only by test-mode viewport hosts. */
export function materialViewportTestSnapshot(
  visual: AbstractMesh,
): MaterialViewportTestSnapshot {
  const material = visual.material;
  const blocks =
    material?.getClassName() === "NodeMaterial"
      ? (material as NodeMaterial).getInputBlocks()
      : [];
  return {
    meshUniqueId: visual.uniqueId,
    materialUniqueId: material?.uniqueId ?? null,
    materialInputs: Object.fromEntries(
      blocks.flatMap((block) => {
        const value = block.value as
          number | { asArray?: () => number[] } | null;
        const components =
          typeof value === "number" ? [value] : value?.asArray?.();
        return components ? [[block.name, components]] : [];
      }),
    ),
  };
}

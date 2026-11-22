import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";

export type MaterialViewportTestSnapshot = {
  meshUniqueId: number;
  diagnostic: unknown;
  materialUniqueId: number | null;
  materialInputs: Record<string, number[]>;
};

/** Read the live assigned shader; called only by test-mode viewport hosts. */
export function materialViewportTestSnapshot(
  visual: AbstractMesh,
): MaterialViewportTestSnapshot {
  const material = visual.material;
  // Its uniforms and constants, and the values it reads from its record (`MaterialRecordReadBlock`): parameters and
  // hoisted literals, as authored.
  const blocks: Array<{ name: string; value: unknown }> =
    material?.getClassName() === "NodeMaterial"
      ? [
        ...(material as NodeMaterial).getInputBlocks(),
        ...(material as NodeMaterial).attachedBlocks.filter((block) => block.getClassName() === "MaterialRecordReadBlock") as unknown as Array<{ name: string; value: unknown }>,
      ]
      : [];
  return {
    meshUniqueId: visual.uniqueId,
    diagnostic: {
      enabled: visual.isEnabled(), visible: visual.isVisible, visibility: visual.visibility,
      vertices: visual.getTotalVertices(), world: Array.from(visual.getWorldMatrix().asArray()),
      bounds: [visual.getBoundingInfo().boundingBox.minimumWorld.asArray(), visual.getBoundingInfo().boundingBox.maximumWorld.asArray()],
      material: material ? { backFaceCulling: material.backFaceCulling,
        alpha: material.alpha, textures: material.getActiveTextures().map(texture => ({
          name: texture.name, ready: texture.isReady(), size: texture.getSize(), alpha: texture.hasAlpha,
          disposed: !texture.getInternalTexture(),
        })) } : null,
    },
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

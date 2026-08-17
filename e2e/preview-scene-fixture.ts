import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "../packages/core/src/index.ts";

/** Shared placement fixture for editor Play, Preview Build, and packed player. */
export function previewPlacementScene(
  materialGuid: string | null = null,
): SerializedScene {
  const parentMesh = createMeshComponent("scene-mesh", "box");
  parentMesh.properties.materialGuid = materialGuid;
  const childMesh = createMeshComponent("child-mesh", "sphere");
  return {
    ...createDefaultScene(),
    name: "PreviewPlacement",
    actors: [
      createActor("material-actor", "Material Actor", {
        transform: {
          ...identitySerializedTransform(),
          position: [-3, 1, 0],
        },
        components: [parentMesh],
      }),
      createActor("child-actor", "Child Actor", {
        parentId: "material-actor",
        transform: {
          ...identitySerializedTransform(),
          position: [2, 0, 0],
        },
        components: [childMesh],
      }),
      createActor("far-actor", "Far Actor", {
        transform: {
          ...identitySerializedTransform(),
          position: [4, -1, 0],
        },
        components: [createMeshComponent("far-mesh", "cylinder")],
      }),
    ],
  };
}

export const EXPECTED_PREVIEW_ACTOR_POSITIONS = [
  [-3, 1, 0],
  [-1, 1, 0],
  [4, -1, 0],
] as const;

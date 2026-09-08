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
  const base = createDefaultScene();
  // Keep the seeded directional sun. This helper used to replace `actors` and
  // rely on the unnamed viewport hemi; PBR primitives are otherwise black.
  const sun = base.actors.find((actor) =>
    actor.components.some(
      (component) => component.classId === "LightComponent",
    ),
  );
  return {
    ...base,
    name: "PreviewPlacement",
    actors: [
      ...(sun ? [sun] : []),
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

/** Legacy duplicated components must still give all eight spheres colliders. */
export function previewPhysicsScene(): SerializedScene {
  const scene = createDefaultScene();
  const ramp = createActor("ramp", "Angled Cube", {
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, -Math.sin(Math.PI / 18), Math.cos(Math.PI / 18)],
      scale: [80, 1, 28],
    },
    components: [createMeshComponent("ramp-mesh", "box")],
  });
  scene.actors.push(ramp);
  for (let index = 0; index < 8; index += 1) {
    scene.actors.push(
      createActor(`sphere-${index}`, `Sphere ${index + 1}`, {
        transform: {
          ...identitySerializedTransform(),
          position: [-5, 8, -10.5 + index * 3],
        },
        // Older editor duplication copied these ids verbatim between actors.
        components: [
          createMeshComponent("shared-sphere-mesh", "sphere"),
          {
            id: "shared-body",
            classId: "RigidBodyComponent",
            properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
          },
        ],
      }),
    );
  }
  return scene;
}

/** The last two lights must contribute pixels, beyond Babylon's four-light default. */
export function previewManyLightsScene(): SerializedScene {
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.grid.showGrid = false;
  scene.actors = [
    createActor("lit-sphere", "Lit Sphere", {
      transform: { ...identitySerializedTransform(), scale: [5, 5, 5] },
      components: [createMeshComponent("lit-sphere-mesh", "sphere")],
    }),
  ];
  for (let index = 0; index < 6; index += 1) {
    scene.actors.push(
      createActor(`light-${index}`, `Light ${index + 1}`, {
        components: [
          {
            id: `fill-${index}`,
            classId: "HemisphericFillLightComponent",
            properties: {
              enabled: true,
              color: index < 4 ? [1, 0, 0] : [0, 1, 0],
              groundColor: index < 4 ? [1, 0, 0] : [0, 1, 0],
              intensity: index < 4 ? 0.01 : 1,
            },
          },
        ],
      }),
    );
  }
  return scene;
}

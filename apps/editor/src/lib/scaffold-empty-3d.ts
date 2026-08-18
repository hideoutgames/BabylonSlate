import {
  createDefaultAnimGraph,
  type AnimGraphDocument,
} from "@babylonslate/anim-graph";
import {
  DOCUMENT_CHUNK_ID,
  newAssetGuid,
  normalizeAnimationPayload,
  normalizeSkeletonPayload,
  type AssetRegistry,
  type ImportResult,
} from "@babylonslate/assets";
import {
  createMeshComponent,
  identitySerializedTransform,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import {
  buildNewAssetResult,
  newAssetFileName,
} from "./content-browser-helpers";

export const MANNEQUIN_CLASS_FILE = "Mannequin.class.babasset";
export const MANNEQUIN_ANIM_GRAPH_FILE = "Mannequin.anim.babasset";
export const MANNEQUIN_CLASS_ID = "Mannequin";
export const MANNEQUIN_ACTOR_ID = "actor-1";

function withDocumentPayload(
  result: ImportResult,
  payload: Record<string, unknown>,
): ImportResult {
  return {
    ...result,
    payload,
    chunks: [
      {
        id: DOCUMENT_CHUNK_ID,
        kind: "document",
        mime: "application/json",
        data: new TextEncoder().encode(JSON.stringify(payload)),
      },
    ],
  };
}

function idleAnimationFromImport(
  created: ReturnType<AssetRegistry["list"]>,
): ReturnType<AssetRegistry["list"]>[number] | undefined {
  return created.find((asset) => {
    if (asset.header.type !== "Animation") return false;
    return (
      normalizeAnimationPayload(asset.header.payload).clipName.toLowerCase() ===
      "idle"
    );
  });
}

function replaceDefaultCubeActor(
  scene: SerializedScene,
  options: { modelGuid: string; graphGuid: string },
): SerializedScene {
  return {
    ...scene,
    actors: scene.actors.map((actor) => {
      if (actor.id !== MANNEQUIN_ACTOR_ID) return actor;
      const mesh =
        actor.components.find(
          (component) => component.classId === "MeshComponent",
        ) ?? createMeshComponent("component-1", "box");
      return {
        ...actor,
        name: MANNEQUIN_CLASS_ID,
        classId: MANNEQUIN_CLASS_ID,
        components: [
          {
            ...mesh,
            properties: {
              ...mesh.properties,
              assetGuid: options.modelGuid,
            },
          },
          {
            id: "component-anim-graph",
            classId: "AnimationGraphComponent",
            properties: { graphGuid: options.graphGuid },
            parentId: null,
            transform: identitySerializedTransform(),
          },
        ],
      };
    }),
  };
}

/**
 * Import Kenney Mannequin (hierarchy rig), write Class + idle Anim Graph, and
 * replace the default Cube actor. `createDefaultScene()` itself stays Cube.
 */
export async function applyKenneyMannequinEmptyScaffold(options: {
  registry: AssetRegistry;
  scene: SerializedScene;
  mannequinBytes: Uint8Array;
}): Promise<SerializedScene> {
  const created = await options.registry.importFile(
    "project",
    "",
    "mannequin.glb",
    options.mannequinBytes,
  );
  const model = created.find((asset) => asset.header.type === "Model");
  const skeleton = created.find((asset) => asset.header.type === "Skeleton");
  if (!model) {
    throw new Error("Kenney Mannequin import did not create a Model.");
  }
  if (!skeleton) {
    throw new Error("Kenney Mannequin import did not create a Skeleton.");
  }
  const kind = normalizeSkeletonPayload(skeleton.header.payload).kind;
  if (kind !== "hierarchy") {
    throw new Error(
      `Kenney Mannequin must import as a hierarchy Skeleton (got ${kind}).`,
    );
  }
  const idle = idleAnimationFromImport(created);
  if (!idle) {
    throw new Error("Kenney Mannequin is missing an idle Animation.");
  }
  const idlePayload = normalizeAnimationPayload(idle.header.payload);

  const graphGuid = newAssetGuid();
  const animGraph: AnimGraphDocument = createDefaultAnimGraph(MANNEQUIN_CLASS_ID);
  const idleClip = animGraph.clips[0];
  if (idleClip) {
    idleClip.kind = "animation";
    idleClip.assetGuid = idle.header.guid;
    idleClip.clipName = idlePayload.clipName;
    idleClip.durationMs = idlePayload.durationMs ?? idleClip.durationMs;
  }
  const graphResult = withDocumentPayload(
    {
      ...buildNewAssetResult({
        type: "AnimationGraph",
        name: MANNEQUIN_CLASS_ID,
        guid: graphGuid,
        parentClass: null,
      }),
      dependencies: [idle.header.guid],
    },
    animGraph as unknown as Record<string, unknown>,
  );

  const mesh = createMeshComponent("prefab-mesh", "box");
  mesh.properties.assetGuid = model.header.guid;
  const classPayload = buildNewAssetResult({
    type: "Class",
    name: MANNEQUIN_CLASS_ID,
    guid: newAssetGuid(),
    parentClass: "Actor",
  });
  const classGraph = classPayload.payload as SerializedGraph;
  classGraph.components = [
    mesh,
    {
      id: "prefab-anim-graph",
      classId: "AnimationGraphComponent",
      properties: { graphGuid },
      parentId: null,
      transform: identitySerializedTransform(),
    },
  ];
  const classResult = withDocumentPayload(
    {
      ...classPayload,
      dependencies: [model.header.guid, graphGuid],
    },
    classGraph as unknown as Record<string, unknown>,
  );

  await options.registry.createAsset(
    "project",
    newAssetFileName("AnimationGraph", MANNEQUIN_CLASS_ID),
    graphResult,
  );
  await options.registry.createAsset(
    "project",
    newAssetFileName("Class", MANNEQUIN_CLASS_ID),
    classResult,
  );

  return replaceDefaultCubeActor(options.scene, {
    modelGuid: model.header.guid,
    graphGuid,
  });
}

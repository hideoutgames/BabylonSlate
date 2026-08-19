import {
  createActor,
  createMeshComponent,
  createSkyboxComponent,
  createText3DComponent,
  identitySerializedTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  resolveActorTypeVisual,
  resolveTypeVisual,
  type TypeVisual,
} from "@babylonslate/editor-kit";
import { defaultPropertiesFor } from "../panels/add-component-catalog";
import {
  defaultPrefabComponents,
  instantiatePrefabComponents,
  prefabComponentsFromGraph,
} from "./prefab-preview";
import { classIdFromClassAsset } from "./content-browser-helpers";

export type PlaceActorKind =
  | { type: "shape"; meshKind: string }
  | { type: "light"; lightKind: string }
  | { type: "camera" }
  | { type: "skybox" }
  | { type: "text3d" }
  | { type: "navmesh" }
  | { type: "navmesh-blocker" }
  | { type: "blocking-volume" }
  | { type: "audio" }
  | { type: "particle" }
  | { type: "empty" }
  | {
      type: "asset";
      name: string;
      guid: string;
      assetType?: string;
      classId?: string;
      components?: SerializedComponent[];
    };

export type PlaceActorItem = {
  id: string;
  title: string;
  category: string;
  kind: PlaceActorKind;
};

const SHAPES = ["box", "sphere", "cylinder", "plane", "ground"] as const;
const LIGHTS = ["point", "directional", "spot"] as const;

export const ENGINE_PLACE_ACTORS: PlaceActorItem[] = [
  ...SHAPES.map((meshKind) => ({
    id: `shape-${meshKind}`,
    title: meshKind,
    category: "Shapes",
    kind: { type: "shape" as const, meshKind },
  })),
  ...LIGHTS.map((lightKind) => ({
    id: `light-${lightKind}`,
    title: `${lightKind[0]!.toUpperCase()}${lightKind.slice(1)} Light`,
    category: "Lights",
    kind: { type: "light" as const, lightKind },
  })),
  {
    id: "camera",
    title: "Camera",
    category: "Camera",
    kind: { type: "camera" },
  },
  {
    id: "skybox",
    title: "Skybox",
    category: "Environment",
    kind: { type: "skybox" },
  },
  {
    id: "text3d",
    title: "3D Text",
    category: "Environment",
    kind: { type: "text3d" },
  },
  {
    id: "empty",
    title: "Empty Actor",
    category: "Empty",
    kind: { type: "empty" },
  },
  {
    id: "navmesh",
    title: "NavMesh",
    category: "Navigation",
    kind: { type: "navmesh" },
  },
  {
    id: "navmesh-blocker",
    title: "NavMesh Blocker",
    category: "Navigation",
    kind: { type: "navmesh-blocker" },
  },
  {
    id: "blocking-volume",
    title: "Blocking Volume",
    category: "Physics",
    kind: { type: "blocking-volume" },
  },
  {
    id: "audio",
    title: "Audio",
    category: "Audio",
    kind: { type: "audio" },
  },
  {
    id: "particle",
    title: "Particle",
    category: "Particles",
    kind: { type: "particle" },
  },
];

export const PLACEABLE_PROJECT_TYPES = new Set([
  "Class",
  "Model",
  "Audio",
  "ParticleSystem",
]);

export function prefabComponentsForGuid(
  guid: string,
  options: {
    assets: Array<{
      path?: string;
      header: { guid: string; name: string; type?: string };
    }>;
    graphForPath: (
      path: string,
    ) => { components?: SerializedComponent[] } | undefined;
  },
): SerializedComponent[] | undefined {
  const asset = options.assets.find((entry) => entry.header.guid === guid);
  if (!asset?.path || asset.header.type !== "Class") return undefined;
  const graph = options.graphForPath(asset.path);
  if (!graph) return undefined;
  return prefabComponentsFromGraph(graph);
}

export function projectPlaceActors(
  assets: Array<{
    path?: string;
    header: { guid: string; name: string; type?: string };
  }>,
  prefabForGuid?: (guid: string) => SerializedComponent[] | undefined,
): PlaceActorItem[] {
  return assets
    .filter((asset) => PLACEABLE_PROJECT_TYPES.has(asset.header.type ?? ""))
    .map((asset) => ({
      id: `asset-${asset.header.guid}`,
      title: asset.header.name,
      category: "Project",
      kind: {
        type: "asset" as const,
        name: asset.header.name,
        guid: asset.header.guid,
        assetType: asset.header.type,
        classId:
          asset.header.type === "Class"
            ? classIdFromClassAsset({
                path: asset.path,
                header: { type: "Class", name: asset.header.name },
              })
            : undefined,
        components: prefabForGuid?.(asset.header.guid),
      },
    }));
}

export function visualForPlaceActor(item: PlaceActorItem): TypeVisual {
  const kind = item.kind;
  if (kind.type === "shape") {
    return resolveTypeVisual({ classId: "MeshComponent", family: "class" });
  }
  if (kind.type === "light") {
    return resolveTypeVisual({ classId: "LightComponent", family: "class" });
  }
  if (kind.type === "camera") {
    return resolveTypeVisual({ classId: "CameraComponent", family: "class" });
  }
  if (kind.type === "skybox") {
    return resolveTypeVisual({ classId: "SkyboxComponent", family: "class" });
  }
  if (kind.type === "text3d") {
    return resolveTypeVisual({ classId: "Text3DComponent", family: "class" });
  }
  if (kind.type === "navmesh") {
    return resolveTypeVisual({ classId: "NavMeshComponent", family: "class" });
  }
  if (kind.type === "navmesh-blocker") {
    return resolveTypeVisual({
      classId: "NavMeshBlockerComponent",
      family: "class",
    });
  }
  if (kind.type === "blocking-volume") {
    return resolveTypeVisual({
      classId: "BlockingVolumeComponent",
      family: "class",
    });
  }
  if (kind.type === "audio") {
    return resolveTypeVisual({ classId: "AudioComponent", family: "class" });
  }
  if (kind.type === "particle") {
    return resolveTypeVisual({ classId: "ParticleComponent", family: "class" });
  }
  if (kind.type === "asset") {
    return resolveTypeVisual({ assetType: kind.assetType });
  }
  return resolveActorTypeVisual({ classId: "Actor" });
}

export function nextActorId(scene: SerializedScene): string {
  let index = 1;
  while (scene.actors.some((actor) => actor.id === `actor-${index}`)) {
    index += 1;
  }
  return `actor-${index}`;
}

function placedTransform(position: [number, number, number]) {
  return {
    ...identitySerializedTransform(),
    position,
  };
}

export function spawnPlacedActor(
  scene: SerializedScene,
  item: PlaceActorItem,
  id: string,
  position: [number, number, number],
): SerializedActor {
  const kind = item.kind;
  const transform = placedTransform(position);
  if (kind.type === "shape") {
    return createActor(id, kind.meshKind, {
      transform,
      components: [createMeshComponent(`${id}-mesh`, kind.meshKind)],
    });
  }
  if (kind.type === "light") {
    return createActor(id, item.title, {
      transform,
      components: [
        {
          id: `${id}-light`,
          classId: "LightComponent",
          properties: {
            ...defaultPropertiesFor("LightComponent"),
            lightKind: kind.lightKind,
          },
        },
      ],
    });
  }
  if (kind.type === "camera") {
    return createActor(id, "Camera", {
      transform,
      components: [
        {
          id: `${id}-camera`,
          classId: "CameraComponent",
          properties: defaultPropertiesFor(
            "CameraComponent",
            scene.settings.physicsWorld,
            scene.viewportMode,
          ),
        },
      ],
    });
  }
  if (kind.type === "skybox") {
    return createActor(id, "Skybox", {
      transform,
      locked: true,
      components: [createSkyboxComponent(`${id}-skybox`)],
    });
  }
  if (kind.type === "text3d") {
    return createActor(id, "3D Text", {
      transform,
      components: [createText3DComponent(`${id}-text3d`)],
    });
  }
  if (kind.type === "navmesh") {
    return createActor(id, "NavMesh", {
      transform,
      components: [
        {
          id: `${id}-navmesh`,
          classId: "NavMeshComponent",
          properties: defaultPropertiesFor("NavMeshComponent"),
        },
      ],
    });
  }
  if (kind.type === "navmesh-blocker") {
    return createActor(id, "NavMesh Blocker", {
      transform,
      components: [
        {
          id: `${id}-blocker`,
          classId: "NavMeshBlockerComponent",
          properties: defaultPropertiesFor("NavMeshBlockerComponent"),
        },
      ],
    });
  }
  if (kind.type === "blocking-volume") {
    return createActor(id, "Blocking Volume", {
      transform,
      components: [
        {
          id: `${id}-blocking`,
          classId: "BlockingVolumeComponent",
          properties: defaultPropertiesFor("BlockingVolumeComponent"),
        },
      ],
    });
  }
  if (kind.type === "audio") {
    return createActor(id, "Audio", {
      transform,
      components: [
        {
          id: `${id}-audio`,
          classId: "AudioComponent",
          properties: defaultPropertiesFor("AudioComponent"),
        },
      ],
    });
  }
  if (kind.type === "particle") {
    return createActor(id, "Particle", {
      transform,
      components: [
        {
          id: `${id}-particle`,
          classId: "ParticleComponent",
          properties: defaultPropertiesFor("ParticleComponent"),
        },
      ],
    });
  }
  if (kind.type === "asset") {
    if (kind.assetType === "Class") {
      return createActor(id, kind.name, {
        classId: kind.classId ?? kind.name,
        transform,
        components: instantiatePrefabComponents(
          kind.components ?? defaultPrefabComponents(),
          id,
        ),
      });
    }
    if (kind.assetType === "Audio") {
      return createActor(id, kind.name, {
        transform,
        components: [
          {
            id: `${id}-audio`,
            classId: "AudioComponent",
            properties: {
              ...defaultPropertiesFor("AudioComponent"),
              audioAssetGuid: kind.guid,
              playOnStart: true,
              loop: false,
              volume: 1,
            },
          },
        ],
      });
    }
    if (kind.assetType === "ParticleSystem") {
      return createActor(id, kind.name, {
        transform,
        components: [
          {
            id: `${id}-particle`,
            classId: "ParticleComponent",
            properties: {
              ...defaultPropertiesFor("ParticleComponent"),
              particleSystemGuid: kind.guid,
              playOnStart: true,
            },
          },
        ],
      });
    }
    const component = createMeshComponent(`${id}-mesh`, "box");
    component.properties.assetGuid = kind.guid;
    return createActor(id, kind.name, { transform, components: [component] });
  }
  return createActor(id, "Empty", { transform });
}

export function duplicateSceneActor(
  scene: SerializedScene,
  source: SerializedActor,
  options?: {
    position?: [number, number, number];
    parentId?: string | null;
  },
): SerializedActor {
  const copy = structuredClone(source);
  copy.id = nextActorId(scene);
  copy.name = `${source.name} Copy`;
  if (options && "parentId" in options) {
    copy.parentId = options.parentId ?? null;
  }
  if (options?.position) {
    copy.transform = { ...copy.transform, position: options.position };
  }
  return copy;
}

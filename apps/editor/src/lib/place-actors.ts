import {
  createActor,
  createMeshComponent,
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

export type PlaceActorKind =
  | { type: "shape"; meshKind: string }
  | { type: "light"; lightKind: string }
  | { type: "camera" }
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
    id: "empty",
    title: "Empty Actor",
    category: "Empty",
    kind: { type: "empty" },
  },
];

export const PLACEABLE_PROJECT_TYPES = new Set(["Class", "Model"]);

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
          asset.header.type === "Class" ? asset.header.name : undefined,
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
  if (kind.type === "asset") {
    return resolveTypeVisual({ assetType: kind.assetType });
  }
  return resolveActorTypeVisual({ classId: "Actor" });
}

export function nextActorId(scene: SerializedScene): string {
  let index = scene.actors.length + 1;
  while (scene.actors.some((actor) => actor.id === `actor-${index}`)) {
    index += 1;
  }
  return `actor-${index}`;
}

export function spawnPlacedActor(
  _scene: SerializedScene,
  item: PlaceActorItem,
  id: string,
): SerializedActor {
  const kind = item.kind;
  if (kind.type === "shape") {
    return createActor(id, kind.meshKind, {
      components: [createMeshComponent(`${id}-mesh`, kind.meshKind)],
    });
  }
  if (kind.type === "light") {
    return createActor(id, item.title, {
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
      components: [
        {
          id: `${id}-camera`,
          classId: "CameraComponent",
          properties: defaultPropertiesFor("CameraComponent"),
        },
      ],
    });
  }
  if (kind.type === "asset") {
    if (kind.assetType === "Class") {
      return createActor(id, kind.name, {
        classId: kind.classId ?? kind.name,
        components: instantiatePrefabComponents(
          kind.components ?? defaultPrefabComponents(),
          id,
        ),
      });
    }
    const component = createMeshComponent(`${id}-mesh`, "box");
    component.properties.assetGuid = kind.guid;
    return createActor(id, kind.name, { components: [component] });
  }
  return createActor(id, "Empty");
}

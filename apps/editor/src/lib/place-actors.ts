import {
  createActor,
  createMeshComponent,
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

export type PlaceActorKind =
  | { type: "shape"; meshKind: string }
  | { type: "light"; lightKind: string }
  | { type: "camera" }
  | { type: "navmesh" }
  | { type: "navmesh-blocker" }
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
  if (kind.type === "navmesh") {
    return resolveTypeVisual({ classId: "NavMeshComponent", family: "class" });
  }
  if (kind.type === "navmesh-blocker") {
    return resolveTypeVisual({
      classId: "NavMeshBlockerComponent",
      family: "class",
    });
  }
  if (kind.type === "asset") {
    return resolveTypeVisual({ assetType: kind.assetType });
  }
  return resolveActorTypeVisual({ classId: "Actor" });
}

/** Engine primitives are 1.5 units across, so 2 units always leaves a visible gap. */
const PLACEMENT_SPACING = 2;

/**
 * First free spot along +X, so a placed actor is never hidden inside one that is
 * already there. A sphere dropped on the default Cube at the origin is fully
 * enclosed by it and reads as "the actor did not spawn".
 */
export function placementPositionFor(
  scene: SerializedScene,
): [number, number, number] {
  // Child actors move with their parent, so only root actors define free space.
  const occupied = scene.actors
    .filter((actor) => actor.parentId === null)
    .map((actor) => actor.transform.position);
  const clashes = (candidate: readonly [number, number, number]) =>
    occupied.some((position) =>
      position.every(
        (value, axis) => Math.abs(value - candidate[axis]!) < PLACEMENT_SPACING,
      ),
    );
  // One occupied actor can block at most the two candidates it sits between.
  const attempts = occupied.length * 2 + 1;
  for (let step = 0; step < attempts; step += 1) {
    const candidate: [number, number, number] = [step * PLACEMENT_SPACING, 0, 0];
    if (!clashes(candidate)) return candidate;
  }
  return [attempts * PLACEMENT_SPACING, 0, 0];
}

function placedTransform(scene: SerializedScene) {
  return {
    ...identitySerializedTransform(),
    position: placementPositionFor(scene),
  };
}

export function nextActorId(scene: SerializedScene): string {
  let index = scene.actors.length + 1;
  while (scene.actors.some((actor) => actor.id === `actor-${index}`)) {
    index += 1;
  }
  return `actor-${index}`;
}

export function spawnPlacedActor(
  scene: SerializedScene,
  item: PlaceActorItem,
  id: string,
): SerializedActor {
  const kind = item.kind;
  const transform = placedTransform(scene);
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
  if (kind.type === "navmesh") {
    return createActor(id, "NavMesh", {
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
      components: [
        {
          id: `${id}-blocker`,
          classId: "NavMeshBlockerComponent",
          properties: defaultPropertiesFor("NavMeshBlockerComponent"),
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
    const component = createMeshComponent(`${id}-mesh`, "box");
    component.properties.assetGuid = kind.guid;
    return createActor(id, kind.name, { transform, components: [component] });
  }
  return createActor(id, "Empty", { transform });
}

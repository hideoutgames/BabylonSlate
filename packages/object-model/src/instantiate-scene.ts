import type {
  SerializedActor,
  SerializedComponent,
  SerializedTransform,
  Transform,
} from "@babylonslate/core";
import {
  identitySerializedTransform,
  isSceneLayerDeniedComponent,
} from "@babylonslate/core";
import type { LifecycleHooks } from "./objects";
import type { Actor } from "./objects";
import type { World } from "./world";
import { hydrateClassVariableValue } from "./class-registry";

export type SceneActorHooks = (
  classId: string,
) => LifecycleHooks<Actor> | undefined;

/** Convert a scene-document transform (tuples) into a runtime Transform. */
export function runtimeTransformFromSerialized(
  transform: SerializedTransform,
): Transform {
  return {
    position: {
      x: transform.position[0],
      y: transform.position[1],
      z: transform.position[2],
    },
    rotation: {
      x: transform.rotation[0],
      y: transform.rotation[1],
      z: transform.rotation[2],
      w: transform.rotation[3],
    },
    scale: {
      x: transform.scale[0],
      y: transform.scale[1],
      z: transform.scale[2],
    },
  };
}

function stringProp(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  const guid = properties[key];
  return typeof guid === "string" && guid.length > 0 ? guid : null;
}

function componentAssetGuid(component: SerializedComponent): string | null {
  if (component.classId === "MeshComponent") {
    return stringProp(component.properties, "assetGuid");
  }
  return (
    stringProp(component.properties, "assetGuid") ??
    stringProp(component.properties, "graphGuid") ??
    stringProp(component.properties, "treeGuid") ??
    stringProp(component.properties, "audioAssetGuid") ??
    stringProp(component.properties, "particleSystemGuid") ??
    stringProp(component.properties, "fontAssetGuid") ??
    stringProp(component.properties, "textureGuid") ??
    stringProp(component.properties, "materialGuid")
  );
}

/**
 * Build one unspawned Actor from a scene or SceneLayer document row so callers
 * can yield between owned preparations. Caller then `spawnActorNow`s it.
 */
export function createActorFromSerialized(
  world: World,
  serialized: SerializedActor,
  hooksFor?: SceneActorHooks,
  sceneLayerId?: string,
): Actor | null {
  if (
    !sceneLayerId &&
    world.classRegistry.isA(serialized.classId, "SceneLayerActor")
  ) {
    return null;
  }
  const variables = structuredClone(serialized.properties ?? {});
  for (const variable of world.classRegistry.inheritedVariables(serialized.classId)) {
    if (!Object.hasOwn(variables, variable.name) || !variable.container) continue;
    variables[variable.name] = hydrateClassVariableValue({ ...variable, defaultValue: variables[variable.name] });
  }
  const actor = world.createActor({
    guid: serialized.id,
    classId: serialized.classId,
    variables: {
      ...variables,
      name: serialized.name,
      visible: serialized.visible,
      locked: serialized.locked,
      parentId: serialized.parentId,
    },
    transform: runtimeTransformFromSerialized(serialized.transform),
    hooks: hooksFor?.(serialized.classId),
    sceneLayerId: sceneLayerId ?? null,
    suppressedComponentSourceIds: serialized.suppressedComponentSourceIds,
  });
  attachSerializedComponents(world, actor, serialized.components);
  return actor;
}

/** Attach scene components or instantiate prefab templates with actor-scoped identities. */
export function attachSerializedComponents(
  world: World,
  actor: Actor,
  components: readonly SerializedComponent[],
  options: { freshIds?: boolean } = {},
): void {
  const suppressed = actor.suppressedComponentSourceIds.length ? new Set(components.filter((component) => {
    const sourceId = options.freshIds ? component.id : component.sourceId;
    return !!sourceId && actor.suppressedComponentSourceIds.includes(sourceId);
  }).map((component) => component.id)) : null;
  const activeComponents = suppressed ? components.filter((component) => !suppressed.has(component.id)) : components;
  const ids = new Map(
    activeComponents.map((component) => [
      component.id,
      options.freshIds ? `${actor.guid}:${component.id}` : component.id,
    ]),
  );
  for (const component of activeComponents) {
    if (actor.sceneLayerId && isSceneLayerDeniedComponent(component.classId)) {
      continue;
    }
    const properties = structuredClone(component.properties);
    if (component.classId === "DeformerComponent" && typeof properties.targetMeshComponentId === "string") {
      const target = components.find((entry) => entry.classId === "MeshComponent" && entry.id === properties.targetMeshComponentId)
        ?? components.find((entry) => entry.classId === "MeshComponent" && entry.sourceId === properties.targetMeshComponentId);
      if (target) properties.targetMeshComponentId = ids.get(target.id)!;
    }
    actor.attachComponent(
      world.createComponent({
        guid: ids.get(component.id),
        classId: component.classId,
        variables: properties,
        assetGuid: componentAssetGuid(component),
        sourceId: options.freshIds
          ? component.id
          : (component.sourceId ?? null),
        parentId: component.parentId && !suppressed?.has(component.parentId)
          ? (ids.get(component.parentId) ??
            (options.freshIds ? null : component.parentId))
          : null,
        materialInstance: component.materialInstance,
        transform: runtimeTransformFromSerialized(
          component.transform ?? identitySerializedTransform(),
        ),
      }),
    );
  }
}

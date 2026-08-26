import type {
  SerializedActor,
  SerializedComponent,
  SerializedScene,
  SerializedSceneLayer,
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
 * Build World actors from a scene document without spawning them.
 * Caller attaches script hooks (optional) then `spawnActorNow`.
 */
export function createActorsFromSerializedScene(
  world: World,
  scene: SerializedScene,
  hooksFor?: SceneActorHooks,
): Actor[] {
  const actors: Actor[] = [];
  for (const serialized of scene.actors) {
    const actor = createActorFromSerialized(world, serialized, hooksFor);
    if (actor) actors.push(actor);
  }
  return actors;
}

export function createActorsFromSerializedSceneLayer(
  world: World,
  layer: SerializedSceneLayer,
  sceneLayerId: string,
  hooksFor?: SceneActorHooks,
): Actor[] {
  return layer.actors.flatMap((serialized) => {
    const actor = createActorFromSerialized(
      world,
      serialized,
      hooksFor,
      sceneLayerId,
    );
    return actor ? [actor] : [];
  });
}

function createActorFromSerialized(
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
  const actor = world.createActor({
    guid: serialized.id,
    classId: serialized.classId,
    variables: {
      name: serialized.name,
      visible: serialized.visible,
      locked: serialized.locked,
      parentId: serialized.parentId,
    },
    transform: runtimeTransformFromSerialized(serialized.transform),
    hooks: hooksFor?.(serialized.classId),
    sceneLayerId: sceneLayerId ?? null,
  });
  for (const component of serialized.components) {
    if (sceneLayerId && isSceneLayerDeniedComponent(component.classId)) {
      continue;
    }
    actor.attachComponent(
      world.createComponent({
        guid: component.id,
        classId: component.classId,
        variables: { ...component.properties },
        assetGuid: componentAssetGuid(component),
        sourceId: component.sourceId ?? null,
        parentId: component.parentId ?? null,
        transform: runtimeTransformFromSerialized(
          component.transform ?? identitySerializedTransform(),
        ),
      }),
    );
  }
  return actor;
}

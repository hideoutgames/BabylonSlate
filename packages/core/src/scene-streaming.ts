import type { SerializedActor } from "./scene";

export const SCENE_STREAMING_ACTOR_CLASS_ID = "SceneStreamingActor";
export const SCENE_STREAMING_COMPONENT_CLASS_ID = "SceneStreamingComponent";

export const SceneStreamingState = {
  Unloaded: "Unloaded",
  Loading: "Loading",
  Loaded: "Loaded",
  Unloading: "Unloading",
} as const;

export type SceneStreamingState =
  (typeof SceneStreamingState)[keyof typeof SceneStreamingState];

export const SCENE_STREAMING_STATES = Object.values(SceneStreamingState);

export type SceneStreamingProperties = {
  sceneGuid: string;
  sceneName: string;
};

/** Scene asset identity and authoring label; never contains a loaded scene. */
export function normalizeSceneStreamingProperties(value: unknown): SceneStreamingProperties {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    sceneGuid: typeof source.sceneGuid === "string" ? source.sceneGuid.trim() : "",
    sceneName: typeof source.sceneName === "string" ? source.sceneName.trim() : "",
  };
}

/**
 * Remap explicit live references, including nested arrays/maps, without
 * rewriting names, asset guids, or prefab source ids that happen to match.
 */
export function remapSceneStreamingReferences(
  value: unknown,
  idMap: Pick<ReadonlyMap<string, string>, "get">,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => remapSceneStreamingReferences(entry, idMap));
  }
  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [
      remapSceneStreamingReferences(key, idMap),
      remapSceneStreamingReferences(entry, idMap),
    ]));
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const typedReference = typeof source.classId === "string"
    || source.kind === "actorRef" || source.kind === "objectRef";
  return Object.fromEntries(Object.entries(source).map(([key, entry]) => {
    const liveIdentity = /(?:Actor|Component)(?:Id|Guid)$/.test(key)
      || key === "actorId" || key === "actorGuid"
      || key === "componentId" || key === "componentGuid"
      || (typedReference && (key === "guid" || key === "id"));
    return [key, liveIdentity && typeof entry === "string"
      ? idMap.get(entry) ?? entry
      : remapSceneStreamingReferences(entry, idMap)];
  }));
}

/** Clone one independent scene instance, retaining local transforms at its root. */
export function cloneSceneStreamingActors(
  source: readonly SerializedActor[],
  options: { instanceId: string; parentActorId: string },
): SceneStreamingActorClone {
  const steps = cloneSceneStreamingActorsSteps(source, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export type SceneStreamingActorClone = {
  actors: SerializedActor[];
  idMap: Map<string, string>;
  componentIdMaps: Map<string, Map<string, string>>;
};

/** Runtime realization yields between actor work to keep async streaming responsive. */
export function* cloneSceneStreamingActorsSteps(
  source: readonly SerializedActor[],
  options: { instanceId: string; parentActorId: string },
): Generator<void, SceneStreamingActorClone, unknown> {
  const idMap = new Map<string, string>();
  const componentIdMaps = new Map<string, Map<string, string>>();
  const componentCounts = new Map<string, number>();
  for (const actor of source) {
    if (idMap.has(actor.id)) throw new Error(`Duplicate scene actor id: ${actor.id}`);
    // Tuple encoding avoids collisions when ids themselves contain separators.
    idMap.set(actor.id, `scene-stream:${JSON.stringify([options.instanceId, actor.id])}`);
    const components = new Map<string, string>();
    componentIdMaps.set(actor.id, components);
    for (const component of actor.components) {
      if (components.has(component.id)) throw new Error(`Duplicate component id on actor ${actor.id}: ${component.id}`);
      components.set(component.id, `scene-stream:${JSON.stringify([options.instanceId, actor.id, component.id])}`);
      componentCounts.set(component.id, (componentCounts.get(component.id) ?? 0) + 1);
    }
    yield;
  }
  // Globally unique component references remain available to scene scripts;
  // repeated local component ids resolve through their owning actor instead.
  for (const components of componentIdMaps.values()) {
    for (const [id, liveId] of components) {
      if (componentCounts.get(id) === 1 && !idMap.has(id)) idMap.set(id, liveId);
    }
    yield;
  }
  const actorIds = new Set(source.map((actor) => actor.id));
  const actors: SerializedActor[] = [];
  for (const actor of source) {
    const copy = structuredClone(actor);
    const componentIds = componentIdMaps.get(actor.id)!;
    const scopedIds = { get: (id: string) => componentIds.get(id) ?? idMap.get(id) };
    actors.push({
      ...copy,
      id: idMap.get(actor.id)!,
      parentId: actor.parentId && actorIds.has(actor.parentId)
        ? idMap.get(actor.parentId)!
        : options.parentActorId,
      folderId: null,
      components: copy.components.map((component) => ({
        ...component,
        id: componentIds.get(component.id)!,
        sourceId: component.sourceId ?? component.id,
        parentId: component.parentId && componentIds.has(component.parentId)
          ? componentIds.get(component.parentId)!
          : null,
        properties: remapSceneStreamingReferences(component.properties, scopedIds) as Record<string, unknown>,
      })),
    });
    yield;
  }
  return { actors, idMap, componentIdMaps };
}

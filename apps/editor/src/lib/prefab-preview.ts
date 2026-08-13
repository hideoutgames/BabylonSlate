import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";

export const PREFAB_ROOT_ID = "prefab-root";

export function defaultPrefabComponents(): SerializedComponent[] {
  return [createMeshComponent("prefab-mesh", "box")];
}

export function nextPrefabComponentId(
  components: readonly SerializedComponent[],
): string {
  let index = components.length + 1;
  while (components.some((component) => component.id === `prefab-component-${index}`)) {
    index += 1;
  }
  return `prefab-component-${index}`;
}

/** Authored list when present (including empty); otherwise the default mesh. */
export function prefabComponentsFromGraph(
  graph: { components?: SerializedComponent[] } | null | undefined,
): SerializedComponent[] {
  if (graph && Array.isArray(graph.components)) return graph.components;
  return defaultPrefabComponents();
}

export function instantiatePrefabComponents(
  components: readonly SerializedComponent[],
  actorId: string,
): SerializedComponent[] {
  return components.map((component, index) => ({
    id: `${actorId}-${component.classId}-${index + 1}`,
    classId: component.classId,
    properties: { ...component.properties },
  }));
}

/** Reorder session-local prefab components; drop on root moves to the start. */
export function reorderPrefabComponents(
  components: SerializedComponent[],
  dragId: string,
  targetId: string | null,
): SerializedComponent[] {
  const from = components.findIndex((component) => component.id === dragId);
  if (from < 0) return components;
  const next = [...components];
  const [moved] = next.splice(from, 1);
  if (!moved) return components;
  if (!targetId || targetId === PREFAB_ROOT_ID) {
    next.unshift(moved);
    return next;
  }
  const to = next.findIndex((component) => component.id === targetId);
  if (to < 0) {
    next.push(moved);
    return next;
  }
  next.splice(to + 1, 0, moved);
  return next;
}

/** Preview scene holding the prefab's components on a single actor. */
export function previewSceneFor(
  components: SerializedComponent[],
): SerializedScene {
  return {
    ...createDefaultScene(),
    name: "Prefab preview",
    actors: [createActor(PREFAB_ROOT_ID, "Prefab", { components })],
  };
}

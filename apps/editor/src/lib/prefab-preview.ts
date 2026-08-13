import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  wouldCreateComponentCycle,
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
  const idMap = new Map<string, string>();
  for (const [index, component] of components.entries()) {
    idMap.set(component.id, `${actorId}-${component.classId}-${index + 1}`);
  }
  return components.map((component, index) => {
    const parentId =
      component.parentId && idMap.has(component.parentId)
        ? (idMap.get(component.parentId) ?? null)
        : null;
    return {
      id: idMap.get(component.id) ?? `${actorId}-${component.classId}-${index + 1}`,
      classId: component.classId,
      properties: { ...component.properties },
      parentId,
    };
  });
}

/** Nested flatten: Prefab Root then children by `parentId`. */
export function childrenOfPrefabParent(
  components: readonly SerializedComponent[],
  parentId: string | null,
): SerializedComponent[] {
  return components.filter(
    (component) => (component.parentId ?? null) === parentId,
  );
}

export function componentSubtreeIds(
  components: readonly SerializedComponent[],
  rootId: string,
): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const component of components) {
      if (
        component.parentId &&
        ids.has(component.parentId) &&
        !ids.has(component.id)
      ) {
        ids.add(component.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Drop on Prefab Root / null unparents; drop on a row makes that row the parent. */
export function reparentPrefabComponents(
  components: SerializedComponent[],
  dragId: string,
  targetId: string | null,
): SerializedComponent[] {
  if (dragId === PREFAB_ROOT_ID) return components;
  const parentId =
    !targetId || targetId === PREFAB_ROOT_ID ? null : targetId;
  if (parentId === dragId) return components;
  if (wouldCreateComponentCycle(components, dragId, parentId)) {
    return components;
  }
  return components.map((component) =>
    component.id === dragId ? { ...component, parentId } : component,
  );
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

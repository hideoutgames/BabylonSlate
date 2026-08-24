import {
  identitySerializedTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
} from "@babylonslate/core";
import { mergePrefabComponents } from "./prefab-preview";

export const PREFAB_TRANSFORM_OVERRIDE = "transform";
export const PREFAB_PARENT_OVERRIDE = "parentId";

function cloneTransform(
  transform: SerializedTransform | undefined,
): SerializedTransform {
  const source = transform ?? identitySerializedTransform();
  return {
    position: [...source.position] as [number, number, number],
    rotation: [...source.rotation] as [number, number, number, number],
    scale: [...source.scale] as [number, number, number],
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function overrideSet(keys: readonly string[] | undefined): Set<string> {
  return new Set(keys ?? []);
}

function withOverrideKeys(
  keys: Set<string>,
): Pick<SerializedComponent, "overrideKeys"> {
  return keys.size > 0 ? { overrideKeys: [...keys] } : {};
}

function differingOverrideKeys(
  instance: SerializedComponent,
  prefab: SerializedComponent,
): string[] {
  const keys = new Set<string>();
  const propertyKeys = new Set([
    ...Object.keys(instance.properties),
    ...Object.keys(prefab.properties),
  ]);
  for (const key of propertyKeys) {
    if (!jsonEqual(instance.properties[key], prefab.properties[key])) {
      keys.add(key);
    }
  }
  if (
    !jsonEqual(
      instance.transform ?? identitySerializedTransform(),
      prefab.transform ?? identitySerializedTransform(),
    )
  ) {
    keys.add(PREFAB_TRANSFORM_OVERRIDE);
  }
  return [...keys];
}

function nextInstanceComponentId(
  actorId: string,
  classId: string,
  used: Set<string>,
): string {
  let index = 1;
  let id = `${actorId}-${classId}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${actorId}-${classId}-${index}`;
  }
  used.add(id);
  return id;
}

function instantiateFromPrefab(
  prefab: SerializedComponent,
  actorId: string,
  usedIds: Set<string>,
): SerializedComponent {
  return {
    id: nextInstanceComponentId(actorId, prefab.classId, usedIds),
    classId: prefab.classId,
    properties: { ...prefab.properties },
    parentId: null,
    sourceId: prefab.id,
    transform: cloneTransform(prefab.transform),
  };
}

function migrateUnsourcedComponents(
  components: readonly SerializedComponent[],
  prefabComponents: readonly SerializedComponent[],
): SerializedComponent[] {
  const claimed = new Set(
    components
      .map((component) => component.sourceId)
      .filter((id): id is string => typeof id === "string"),
  );
  const queues = new Map<string, SerializedComponent[]>();
  for (const prefab of prefabComponents) {
    if (claimed.has(prefab.id)) continue;
    const queue = queues.get(prefab.classId) ?? [];
    queue.push(prefab);
    queues.set(prefab.classId, queue);
  }
  return components.map((component) => {
    if (component.sourceId) return component;
    const queue = queues.get(component.classId);
    const match = queue?.shift();
    if (!match) return component;
    const overrideKeys = differingOverrideKeys(component, match);
    return {
      ...component,
      sourceId: match.id,
      ...withOverrideKeys(new Set(overrideKeys)),
    };
  });
}

function remapPrefabParentId(
  prefabParentId: string | null | undefined,
  sourceToId: Map<string, string>,
): string | null {
  if (!prefabParentId) return null;
  return sourceToId.get(prefabParentId) ?? null;
}

/** Merge a Class prefab onto one actor's components without wiping instance overrides. */
export function syncActorComponentsFromPrefab(
  actor: SerializedActor,
  prefabComponents: readonly SerializedComponent[],
): SerializedComponent[] {
  const migrated = migrateUnsourcedComponents(actor.components, prefabComponents);
  const usedIds = new Set(migrated.map((component) => component.id));
  const bySource = new Map<string, SerializedComponent>();
  const extras: SerializedComponent[] = [];
  for (const component of migrated) {
    if (component.sourceId) {
      bySource.set(component.sourceId, component);
    } else {
      extras.push(component);
    }
  }

  const synced: SerializedComponent[] = [];
  for (const prefab of prefabComponents) {
    const existing = bySource.get(prefab.id);
    if (!existing) {
      synced.push(instantiateFromPrefab(prefab, actor.id, usedIds));
      continue;
    }
    const keys = overrideSet(existing.overrideKeys);
    const properties = { ...prefab.properties };
    for (const key of keys) {
      if (key === PREFAB_TRANSFORM_OVERRIDE || key === PREFAB_PARENT_OVERRIDE) {
        continue;
      }
      if (key in existing.properties) {
        properties[key] = existing.properties[key];
      } else {
        delete properties[key];
      }
    }
    synced.push({
      ...existing,
      classId: prefab.classId,
      properties,
      sourceId: prefab.id,
      transform: keys.has(PREFAB_TRANSFORM_OVERRIDE)
        ? cloneTransform(existing.transform)
        : cloneTransform(prefab.transform),
      parentId: keys.has(PREFAB_PARENT_OVERRIDE)
        ? (existing.parentId ?? null)
        : null,
      ...withOverrideKeys(keys),
    });
  }

  const sourceToId = new Map(
    synced
      .filter((component) => component.sourceId)
      .map((component) => [component.sourceId!, component.id]),
  );
  return [
    ...synced.map((component) => {
      const keys = overrideSet(component.overrideKeys);
      if (keys.has(PREFAB_PARENT_OVERRIDE)) return component;
      const prefab = prefabComponents.find(
        (entry) => entry.id === component.sourceId,
      );
      return {
        ...component,
        parentId: remapPrefabParentId(prefab?.parentId, sourceToId),
      };
    }),
    ...extras,
  ];
}

export function syncSceneActorsFromPrefabs(
  scene: SerializedScene,
  prefabsByClassId: Readonly<Record<string, readonly SerializedComponent[]>>,
): SerializedScene {
  let changed = false;
  const actors = scene.actors.map((actor) => {
    const prefab = prefabsByClassId[actor.classId];
    if (!prefab) return actor;
    const components = syncActorComponentsFromPrefab(actor, prefab);
    if (jsonEqual(components, actor.components)) return actor;
    changed = true;
    return { ...actor, components };
  });
  return changed ? { ...scene, actors } : scene;
}

/** Ancestor-merged prefab, or null when the class has no authored prefab. */
export function mergedPrefabComponentsForClass(options: {
  classId: string;
  parentOf: (classId: string) => string | null | undefined;
  graphs: Readonly<
    Record<string, { components?: SerializedComponent[] } | undefined>
  >;
}): SerializedComponent[] | null {
  const ancestors: Array<{
    classId: string;
    components: readonly SerializedComponent[];
  }> = [];
  const seen = new Set<string>();
  const chain: string[] = [];
  let current = options.parentOf(options.classId) ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = options.parentOf(current) ?? null;
  }
  for (const id of [...chain].reverse()) {
    const graph = options.graphs[id];
    if (!graph?.components?.length) continue;
    ancestors.push({ classId: id, components: graph.components });
  }
  const graph = options.graphs[options.classId];
  const hasLocal = graph && Array.isArray(graph.components);
  if (!hasLocal && ancestors.length === 0) return null;
  const local = hasLocal ? graph.components! : [];
  return mergePrefabComponents(ancestors, local);
}

export function prefabTemplatesByClassId(options: {
  classIds: readonly string[];
  parentOf: (classId: string) => string | null | undefined;
  graphs: Readonly<
    Record<string, { components?: SerializedComponent[] } | undefined>
  >;
}): Record<string, SerializedComponent[]> {
  const templates: Record<string, SerializedComponent[]> = {};
  for (const classId of options.classIds) {
    const merged = mergedPrefabComponentsForClass({
      classId,
      parentOf: options.parentOf,
      graphs: options.graphs,
    });
    if (merged) templates[classId] = merged;
  }
  return templates;
}

export function descendantClassIds(
  ancestorId: string,
  classIds: readonly string[],
  parentOf: (classId: string) => string | null | undefined,
): string[] {
  return classIds.filter((classId) => {
    const seen = new Set<string>();
    let current: string | null | undefined = classId;
    while (current && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      current = parentOf(current);
    }
    return false;
  });
}

export function stampUserComponentOverrides(
  previous: SerializedScene,
  next: SerializedScene,
): SerializedScene {
  const beforeActors = new Map(previous.actors.map((actor) => [actor.id, actor]));
  return {
    ...next,
    actors: next.actors.map((actor) => {
      const beforeActor = beforeActors.get(actor.id);
      if (!beforeActor) return actor;
      const beforeComponents = new Map(
        beforeActor.components.map((component) => [component.id, component]),
      );
      return {
        ...actor,
        components: actor.components.map((component) => {
          const before = beforeComponents.get(component.id);
          const sourceId = component.sourceId ?? before?.sourceId;
          if (!sourceId || !before) return component;
          const keys = overrideSet(component.overrideKeys ?? before.overrideKeys);
          for (const key of new Set([
            ...Object.keys(before.properties),
            ...Object.keys(component.properties),
          ])) {
            if (!jsonEqual(before.properties[key], component.properties[key])) {
              keys.add(key);
            }
          }
          if (
            !jsonEqual(
              before.transform ?? identitySerializedTransform(),
              component.transform ?? identitySerializedTransform(),
            )
          ) {
            keys.add(PREFAB_TRANSFORM_OVERRIDE);
          }
          if ((before.parentId ?? null) !== (component.parentId ?? null)) {
            keys.add(PREFAB_PARENT_OVERRIDE);
          }
          return {
            ...component,
            sourceId,
            ...withOverrideKeys(keys),
          };
        }),
      };
    }),
  };
}

export function copyInstanceLinkage(
  from: SerializedScene,
  onto: SerializedScene,
): SerializedScene {
  const fromActors = new Map(from.actors.map((actor) => [actor.id, actor]));
  return {
    ...onto,
    actors: onto.actors.map((actor) => {
      const source = fromActors.get(actor.id);
      if (!source) return actor;
      const fromComponents = new Map(
        source.components.map((component) => [component.id, component]),
      );
      return {
        ...actor,
        components: actor.components.map((component) => {
          const linked = fromComponents.get(component.id);
          if (!linked) return component;
          return {
            ...component,
            ...(linked.sourceId ? { sourceId: linked.sourceId } : {}),
            ...withOverrideKeys(overrideSet(linked.overrideKeys)),
          };
        }),
      };
    }),
  };
}

export function scenesEqualForPrefabSync(
  left: SerializedScene,
  right: SerializedScene,
): boolean {
  return jsonEqual(left.actors, right.actors);
}

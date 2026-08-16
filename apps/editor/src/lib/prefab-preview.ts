import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  wouldCreateComponentCycle,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
} from "@babylonslate/core";

export const PREFAB_ROOT_ID = "prefab-root";

export function defaultPrefabComponents(): SerializedComponent[] {
  return [createMeshComponent("prefab-mesh", "box")];
}

export function nextPrefabComponentId(
  components: readonly SerializedComponent[],
): string {
  let index = components.length + 1;
  while (
    components.some((component) => component.id === `prefab-component-${index}`)
  ) {
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

export type PrefabComponentView = SerializedComponent & {
  /** Declaring parent class id when this row comes from inheritance. */
  inheritedFrom?: string;
};

/**
 * Merge ancestor prefab components (root-first) under local overrides.
 * Child may override transform/properties by id; may add new components;
 * inherited rows keep `inheritedFrom`.
 */
export function mergePrefabComponents(
  ancestors: ReadonlyArray<{
    classId: string;
    components: readonly SerializedComponent[];
  }>,
  local: readonly SerializedComponent[],
): PrefabComponentView[] {
  const byId = new Map<string, PrefabComponentView>();
  for (const ancestor of ancestors) {
    for (const component of ancestor.components) {
      if (byId.has(component.id)) continue;
      byId.set(component.id, {
        ...component,
        properties: { ...component.properties },
        transform: component.transform
          ? {
              position: [...component.transform.position] as [
                number,
                number,
                number,
              ],
              rotation: [...component.transform.rotation] as [
                number,
                number,
                number,
                number,
              ],
              scale: [...component.transform.scale] as [number, number, number],
            }
          : undefined,
        inheritedFrom: ancestor.classId,
      });
    }
  }
  for (const component of local) {
    const prior = byId.get(component.id);
    byId.set(component.id, {
      ...component,
      properties: { ...component.properties },
      transform: component.transform
        ? {
            position: [...component.transform.position] as [
              number,
              number,
              number,
            ],
            rotation: [...component.transform.rotation] as [
              number,
              number,
              number,
              number,
            ],
            scale: [...component.transform.scale] as [number, number, number],
          }
        : undefined,
      ...(prior?.inheritedFrom
        ? { inheritedFrom: prior.inheritedFrom }
        : {}),
    });
  }
  return [...byId.values()];
}

/** Strip view-only inheritance flags before persisting local graph.components. */
export function serializePrefabComponents(
  views: readonly PrefabComponentView[],
): SerializedComponent[] {
  return views.map((component) => {
    const { inheritedFrom: _ignored, ...rest } = component;
    void _ignored;
    return {
      id: rest.id,
      classId: rest.classId,
      properties: { ...rest.properties },
      parentId: rest.parentId ?? null,
      ...(rest.transform ? { transform: rest.transform } : {}),
    };
  });
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
      id:
        idMap.get(component.id) ??
        `${actorId}-${component.classId}-${index + 1}`,
      classId: component.classId,
      properties: { ...component.properties },
      parentId,
      transform: component.transform
        ? {
            position: [...component.transform.position] as [
              number,
              number,
              number,
            ],
            rotation: [...component.transform.rotation] as [
              number,
              number,
              number,
              number,
            ],
            scale: [...component.transform.scale] as [number, number, number],
          }
        : identitySerializedTransform(),
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
  const parentId = !targetId || targetId === PREFAB_ROOT_ID ? null : targetId;
  if (parentId === dragId) return components;
  if (wouldCreateComponentCycle(components, dragId, parentId)) {
    return components;
  }
  return components.map((component) =>
    component.id === dragId ? { ...component, parentId } : component,
  );
}

/** Viewport tap: Prefab Root, a component actor, or nothing on empty space. */
export function prefabSelectedIdFromPick(
  actorId: string | null,
  componentIds: ReadonlySet<string>,
): string | null {
  if (actorId == null) return null;
  if (actorId === PREFAB_ROOT_ID) return PREFAB_ROOT_ID;
  return componentIds.has(actorId) ? actorId : null;
}

/** Gizmo attaches to the selected preview actor (component or Prefab Root). */
export function prefabSelectedActorIds(selectedId: string | null): string[] {
  return selectedId == null ? [] : [selectedId];
}

export function applyPrefabComponentTransform(
  components: readonly SerializedComponent[],
  componentId: string,
  transform: SerializedTransform,
): SerializedComponent[] {
  return components.map((component) =>
    component.id === componentId
      ? {
          ...component,
          transform: cloneTransform(transform),
        }
      : component,
  );
}

const TRANSFORM_EPS = 1e-8;

function cloneTransform(transform: SerializedTransform): SerializedTransform {
  return {
    position: [...transform.position] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number],
  };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= TRANSFORM_EPS;
}

function isIdentityTransform(transform: SerializedTransform): boolean {
  const identity = identitySerializedTransform();
  return (
    near(transform.position[0], identity.position[0]) &&
    near(transform.position[1], identity.position[1]) &&
    near(transform.position[2], identity.position[2]) &&
    near(transform.rotation[0], identity.rotation[0]) &&
    near(transform.rotation[1], identity.rotation[1]) &&
    near(transform.rotation[2], identity.rotation[2]) &&
    near(transform.rotation[3], identity.rotation[3]) &&
    near(transform.scale[0], identity.scale[0]) &&
    near(transform.scale[1], identity.scale[1]) &&
    near(transform.scale[2], identity.scale[2])
  );
}

function quatConjugate(
  q: [number, number, number, number],
): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatMul(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotateVec(
  q: [number, number, number, number],
  v: [number, number, number],
): [number, number, number] {
  const p: [number, number, number, number] = [v[0], v[1], v[2], 0];
  const rotated = quatMul(quatMul(q, p), quatConjugate(q));
  return [rotated[0], rotated[1], rotated[2]];
}

function invertHelperOnLocal(
  helper: SerializedTransform,
  local: SerializedTransform,
): SerializedTransform {
  const invR = quatConjugate(helper.rotation);
  const shifted: [number, number, number] = [
    local.position[0] - helper.position[0],
    local.position[1] - helper.position[1],
    local.position[2] - helper.position[2],
  ];
  const rotated = rotateVec(invR, shifted);
  const sx = helper.scale[0] === 0 ? 1 : helper.scale[0];
  const sy = helper.scale[1] === 0 ? 1 : helper.scale[1];
  const sz = helper.scale[2] === 0 ? 1 : helper.scale[2];
  return {
    position: [rotated[0] / sx, rotated[1] / sy, rotated[2] / sz],
    rotation: quatMul(invR, local.rotation),
    scale: [local.scale[0] / sx, local.scale[1] / sy, local.scale[2] / sz],
  };
}

/**
 * Bake Prefab Root gizmo motion into root-level component locals so the
 * origin stays at (0,0,0) and nested locals are unchanged.
 */
export function applyPrefabPivotDelta(
  components: readonly SerializedComponent[],
  helper: SerializedTransform,
): SerializedComponent[] {
  if (isIdentityTransform(helper)) return [...components];
  return components.map((component) => {
    if (component.parentId) return component;
    const local = component.transform ?? identitySerializedTransform();
    return {
      ...component,
      transform: invertHelperOnLocal(helper, local),
    };
  });
}

function previewVisualComponent(
  component: SerializedComponent,
): SerializedComponent {
  return {
    ...component,
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

function prefabRootPreviewActor() {
  return createActor(PREFAB_ROOT_ID, "Prefab Root", {
    components: [
      {
        id: `${PREFAB_ROOT_ID}-marker`,
        classId: "MeshComponent",
        properties: { meshKind: "pivot", assetGuid: null },
        parentId: null,
        transform: identitySerializedTransform(),
      },
    ],
  });
}

/** Preview: Prefab Root at the origin plus one actor per component. */
export function previewSceneFor(
  components: SerializedComponent[],
): SerializedScene {
  return {
    ...createDefaultScene(),
    name: "Prefab preview",
    actors: [
      prefabRootPreviewActor(),
      ...components.map((component) =>
        createActor(component.id, component.classId, {
          parentId: component.parentId ?? null,
          transform: component.transform ?? identitySerializedTransform(),
          components: [previewVisualComponent(component)],
        }),
      ),
    ],
  };
}

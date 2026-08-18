import { formatValue, serializeTransform } from "@babylonslate/core";
import { BObject } from "./objects";
import type { Actor } from "./objects";
import type { World } from "./world";

export type DebugInspectKind = "gameInstance" | "actor" | "component";

export type DebugInspectNode = {
  id: string;
  kind: DebugInspectKind;
  label: string;
  classId: string;
  parentId: string | null;
  transform?: ReturnType<typeof serializeTransform>;
  variables: Record<string, unknown>;
};

export type DebugInspectSnapshot = {
  tickIndex: number;
  nodes: DebugInspectNode[];
};

function inspectLabel(
  variables: Map<string, unknown>,
  classId: string,
): string {
  const name = variables.get("name");
  return typeof name === "string" && name.length > 0 ? name : classId;
}

function actorParentId(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function sortedSanitizedVariables(
  variables: Map<string, unknown>,
): Record<string, unknown> {
  const keys = [...variables.keys()].sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = sanitizeInspectValue(variables.get(key));
  }
  return out;
}

/** JSON-safe inspect values: primitives stay; BObject → guid/classId; cycles stringify. */
export function sanitizeInspectValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof BObject) {
    return { guid: value.guid, classId: value.classId };
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, current) => {
        if (current instanceof BObject) {
          return { guid: current.guid, classId: current.classId };
        }
        if (
          typeof current === "function" ||
          typeof current === "symbol" ||
          typeof current === "bigint"
        ) {
          return formatValue(current);
        }
        if (current instanceof Map) {
          return Object.fromEntries(current.entries());
        }
        return current;
      }),
    );
  } catch {
    return formatValue(value);
  }
}

function visitActor(
  actor: Actor,
  children: Map<string, Actor[]>,
  nodes: DebugInspectNode[],
): void {
  nodes.push({
    id: actor.guid,
    kind: "actor",
    label: inspectLabel(actor.variables, actor.classId),
    classId: actor.classId,
    parentId: actorParentId(actor),
    transform: serializeTransform(actor.transform),
    variables: sortedSanitizedVariables(actor.variables),
  });
  for (const component of actor.components) {
    nodes.push({
      id: component.guid,
      kind: "component",
      label: inspectLabel(component.variables, component.classId),
      classId: component.classId,
      parentId: actor.guid,
      transform: serializeTransform(component.transform),
      variables: sortedSanitizedVariables(component.variables),
    });
  }
  for (const child of children.get(actor.guid) ?? []) {
    visitActor(child, children, nodes);
  }
}

/** Live Play inspector tree. Separate from harness world snapshots. */
export function createDebugInspectSnapshot(world: World): DebugInspectSnapshot {
  const nodes: DebugInspectNode[] = [];
  const gi = world.gameInstance;
  if (gi) {
    nodes.push({
      id: gi.guid,
      kind: "gameInstance",
      label: inspectLabel(gi.variables, gi.classId),
      classId: gi.classId,
      parentId: null,
      variables: sortedSanitizedVariables(gi.variables),
    });
  }

  const actors = [...world.getActors()];
  const byGuid = new Map(actors.map((actor) => [actor.guid, actor]));
  const children = new Map<string, Actor[]>();
  const roots: Actor[] = [];
  for (const actor of actors) {
    const parentId = actorParentId(actor);
    if (parentId && byGuid.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(actor);
      children.set(parentId, list);
    } else {
      roots.push(actor);
    }
  }
  for (const root of roots) visitActor(root, children, nodes);

  return {
    tickIndex: world.clock.tickIndex,
    nodes,
  };
}

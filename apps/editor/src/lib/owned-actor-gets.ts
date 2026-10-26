import type { SerializedGraph, SerializedScene } from "@haptic/core";
import type { Diagnostic } from "@haptic/scripting";
import {
  OWNED_ACTOR_GET_NODE_ID,
  OWNED_COMPONENT_GET_NODE_ID,
  ownedActorGetTitle,
  ownedComponentGetTitle,
  ownedGetNodeProperties,
  ownedGetProperties,
} from "@haptic/scripting-nodes";
import { prefabComponentLabel } from "../panels/add-component-catalog";

/** An actor a SceneScript's Scene or a SceneLayerScript's layer places, as its Get rows name it. */
export type OwnedActorEntry = {
  id: string;
  name: string;
  classId: string;
  /** `name` is the component's label, numbered when two on the actor share one. */
  components: Array<{ id: string; classId: string; name: string }>;
};

/** The actors (Outliner order) a Scene or Scene Layer tab places, for Get <Actor> / Get <Component> (<Actor>). */
export function ownedActorsOfScene(scene: Pick<SerializedScene, "actors"> | null | undefined): OwnedActorEntry[] {
  return (scene?.actors ?? []).map((actor) => {
    const labels = actor.components.map((component) => prefabComponentLabel(component));
    const seen = new Map<string, number>();
    return {
      id: actor.id,
      name: actor.name,
      classId: actor.classId ?? "Actor",
      components: actor.components.map((component, index) => {
        const label = labels[index]!;
        const repeats = labels.filter((entry) => entry === label).length > 1;
        const count = (seen.get(label) ?? 0) + 1;
        seen.set(label, count);
        return { id: component.id, classId: component.classId, name: repeats && count > 1 ? `${label} ${count}` : label };
      }),
    };
  });
}

function isOwnedGet(type: string): boolean {
  return type === OWNED_ACTOR_GET_NODE_ID || type === OWNED_COMPONENT_GET_NODE_ID;
}

type GraphNodes = SerializedGraph["nodes"];

function refreshNodes(nodes: GraphNodes, actors: readonly OwnedActorEntry[]): GraphNodes {
  let changed = false;
  const next = nodes.map((node) => {
    if (!isOwnedGet(node.type)) return node;
    const { actorId, componentId } = ownedGetProperties(node.data);
    const actor = actors.find((entry) => entry.id === actorId);
    const component = componentId ? actor?.components.find((entry) => entry.id === componentId) : undefined;
    if (!actor || (node.type === OWNED_COMPONENT_GET_NODE_ID && !component)) return node;
    const data: Record<string, unknown> = {
      ...node.data,
      ...ownedGetNodeProperties({
        actorId: actor.id, actorName: actor.name, actorClassId: actor.classId,
        ...(component ? { componentId: component.id, componentName: component.name, componentClassId: component.classId } : {}),
      }),
    };
    data.title = node.type === OWNED_ACTOR_GET_NODE_ID ? ownedActorGetTitle(data) : ownedComponentGetTitle(data);
    if (Object.keys(data).every((key) => data[key] === node.data[key])) return node;
    changed = true;
    return { ...node, data };
  });
  return changed ? next : nodes;
}

/**
 * Show each Get <Actor> / Get <Component> (<Actor>) node under its target's
 * current name and class (a renamed actor, a retyped one). Targets that are
 * gone keep their last names; `ownedGetDiagnostics` reports them.
 */
export function refreshOwnedGetNodes(graph: SerializedGraph, actors: readonly OwnedActorEntry[]): SerializedGraph {
  const nodes = refreshNodes(graph.nodes, actors);
  return nodes === graph.nodes ? graph : { ...graph, nodes };
}

/** Errors for Get <Actor> / Get <Component> (<Actor>) nodes whose actor or component the owner no longer places. */
export function ownedGetDiagnostics(
  graph: SerializedGraph,
  actors: readonly OwnedActorEntry[],
  anchor: { assetGuid: string; graphId: string },
  owner: "Scene" | "Scene Layer",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const slices = [graph.nodes, ...Object.values(graph.functionGraphs ?? {}).map((slice) => slice.nodes)];
  for (const node of slices.flat()) {
    if (!isOwnedGet(node.type)) continue;
    const properties = ownedGetProperties(node.data);
    const actor = actors.find((entry) => entry.id === properties.actorId);
    const title = node.type === OWNED_ACTOR_GET_NODE_ID ? ownedActorGetTitle(node.data) : ownedComponentGetTitle(node.data);
    if (!actor) {
      diagnostics.push({ ...anchor, severity: "error", code: "scene.owned_actor_missing", nodeId: node.id,
        message: `${title}: the actor is no longer in this ${owner}.` });
    } else if (node.type === OWNED_COMPONENT_GET_NODE_ID && !actor.components.some((entry) => entry.id === properties.componentId)) {
      diagnostics.push({ ...anchor, severity: "error", code: "scene.owned_component_missing", nodeId: node.id,
        message: `${title}: ${actor.name} no longer has this component.` });
    }
  }
  return diagnostics;
}

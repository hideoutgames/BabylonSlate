/**
 * Creating and reading a Class document's graph. `graph-validation.ts`
 * re-exports the public names.
 */
import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import { formatEventTitle } from "@haptic/editor-kit";
import {
  toSerializedGraph as logicToSerializedGraph,
  type LogicGraph,
  type NodeRegistry,
  type PinType,
} from "@haptic/scripting";
import {
  ensureCallParentForEvent,
  inheritedCustomEventSeeds,
  LINEAGE_NATIVE_EVENT_TYPES,
  nativeEventStubs,
  NATIVE_CLASS_EVENT_TYPES,
  seededNativeEventTypes,
  COLLISION_EVENT_TYPE_IDS,
  type ClassEventOptions,
} from "../lib/class-members";
import {
  defaultNodeRegistry as registry,
  hydrateSerializedGraphForEditor,
} from "./graph-hydration";

const DEFAULT_EVENT_NODE_IDS: Record<string, string> = {
  "flow.event.beginPlay": "event-begin-play",
  "flow.event.tick": "event-tick",
  "flow.event.init": "event-on-init",
};

function defaultEventNodeId(eventType: string): string {
  return (
    DEFAULT_EVENT_NODE_IDS[eventType] ??
    `event-${eventType.replace(/\./g, "-")}`
  );
}

function pinTypeIdFromPinType(type: PinType | undefined): string {
  if (!type || typeof type !== "object" || !("kind" in type)) return "float";
  const kind = String((type as { kind: string }).kind);
  if (kind === "objectRef") return "object";
  if (kind === "classRef") return "class";
  if (kind === "assetRef") return "asset";
  return kind || "float";
}

/** New graphs seed native (+ inherited custom) events wired to Call Parent. */
export function createDefaultLogicGraphSerialized(
  nodeRegistry: NodeRegistry = registry,
  options?: ClassEventOptions,
): SerializedGraph {
  const seedNatives = new Set<string>(seededNativeEventTypes(options));
  const skipSeedNatives = new Set<string>([
    ...NATIVE_CLASS_EVENT_TYPES,
    ...LINEAGE_NATIVE_EVENT_TYPES,
    ...COLLISION_EVENT_TYPE_IDS,
  ]);
  const stubs = nativeEventStubs(options).filter((stub) => {
    if (!skipSeedNatives.has(stub.eventType)) return true;
    return seedNatives.has(stub.eventType);
  });
  const parentClassId = options?.parentClass?.trim() || null;
  const logic: LogicGraph = {
    id: "main",
    kind: "event",
    nodes: [],
    edges: [],
  };
  let graph = logicToSerializedGraph(logic);

  stubs.forEach((stub, index) => {
    const def = nodeRegistry.get(stub.eventType);
    if (!def) {
      throw new Error(
        `Default event node missing from node registry: ${stub.eventType}`,
      );
    }
    const eventId = defaultEventNodeId(stub.eventType);
    const catalogPins = def.pins({});
    const dataPins: GraphClassMemberPin[] = catalogPins
      .filter((pin) => pin.kind !== "exec" && pin.direction === "out")
      .map((pin) => ({
        name: pin.name,
        typeId: pinTypeIdFromPinType(pin.type),
        direction: "out" as const,
      }));
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: eventId,
          type: stub.eventType,
          position: { x: 80, y: 80 + index * 160 },
          data: {
            title: stub.name,
            ...(dataPins.length > 0 ? { pins: dataPins } : {}),
            __nodeType: stub.eventType,
          },
        },
      ],
    };
    if (parentClassId) {
      graph = ensureCallParentForEvent(graph, {
        eventNodeId: eventId,
        eventType: stub.eventType,
        parentClassId,
        pins: dataPins,
      });
    }
  });

  const inherited = inheritedCustomEventSeeds(options);
  inherited.forEach((event, index) => {
    if (graph.nodes.some((node) => node.type === "flow.event.custom" && node.data.name === event.name)) return;
    // Names that differ only in punctuation ("Foo Bar", "Foo-Bar") share a slug; each gets its own node.
    const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    let eventId = `event-custom-${slug}`;
    for (let suffix = 2; graph.nodes.some((node) => node.id === eventId); suffix++) {
      eventId = `event-custom-${slug}-${suffix}`;
    }
    const y = 80 + (stubs.length + index) * 160;
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: eventId,
          type: "flow.event.custom",
          position: { x: 80, y },
          data: {
            title: formatEventTitle(event.name),
            name: event.name,
            pins: event.pins,
            __nodeType: "flow.event.custom",
          },
        },
      ],
      members: [
        ...(graph.members ?? []),
        {
          id: eventId,
          kind: "event",
          name: event.name,
          pins: event.pins,
        },
      ],
    };
    if (parentClassId) {
      graph = ensureCallParentForEvent(graph, {
        eventNodeId: eventId,
        eventType: "flow.event.custom",
        eventName: event.name,
        parentClassId,
        pins: event.pins,
      });
    }
  });

  return hydrateSerializedGraphForEditor(graph, nodeRegistry, {
    parentOf: options?.parentOf,
  });
}

/**
 * A Class document is a graph. Anything without its node and edge lists is
 * unreadable, never a default graph that a later save would write over it.
 */
export function requireClassGraphPayload(
  payload: Record<string, unknown> | SerializedGraph,
): SerializedGraph {
  if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) {
    return payload as unknown as SerializedGraph;
  }
  throw new Error("The Class document is not a graph: it has no node and edge lists.");
}

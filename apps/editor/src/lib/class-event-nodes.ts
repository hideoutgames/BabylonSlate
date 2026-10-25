import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
} from "@haptic/editor-kit";
import { flowNodes } from "@haptic/scripting-nodes";
import { NATIVE_EVENT_TITLES, type ClassEventOptions } from "./class-event-catalog";
import { nextId } from "./class-member-nodes";

function nodeComponentId(
  node: SerializedGraph["nodes"][number],
): string {
  return typeof node.data.componentId === "string" ? node.data.componentId : "";
}

export function ensureEventNodeOnGraph(
  graph: SerializedGraph,
  eventType: string,
  extras?: {
    name?: string;
    title?: string;
    idFactory?: () => string;
    parentClassId?: string | null;
    pins?: GraphClassMemberPin[];
    componentId?: string;
    eventQualifier?: string;
  },
): SerializedGraph {
  const wantedComponentId = extras?.componentId ?? "";
  const existing = graph.nodes.find((node) => {
    if (node.type !== eventType) return false;
    if (nodeComponentId(node) !== wantedComponentId) return false;
    if (eventType !== "flow.event.custom") return true;
    const named = node.data.name;
    return extras?.name ? named === extras.name : true;
  });
  let next = graph;
  let eventId = existing?.id;
  if (!existing) {
    const id = nextId(extras?.idFactory);
    eventId = id;
    const title = formatEventTitle(
      extras?.title ??
        extras?.name ??
        NATIVE_EVENT_TITLES[eventType] ??
        eventType,
      extras?.eventQualifier,
    );
    const pins = extras?.pins;
    next = {
      ...next,
      nodes: [
        ...next.nodes,
        {
          id,
          type: eventType,
          position: {
            x: 80,
            y: 80 + next.nodes.length * 80,
          },
          data: {
            title,
            ...(extras?.name ? { name: extras.name } : {}),
            ...(pins ? { pins } : {}),
            ...(wantedComponentId ? { componentId: wantedComponentId } : {}),
            ...(extras?.eventQualifier
              ? { eventQualifier: extras.eventQualifier }
              : {}),
            __nodeType: eventType,
          },
        },
      ],
    };
  }
  const parentClassId = extras?.parentClassId?.trim();
  if (!eventId || !parentClassId) return next;
  return ensureCallParentForEvent(next, {
    eventNodeId: eventId,
    eventType,
    eventName: extras?.name,
    parentClassId,
    pins: extras?.pins ?? eventDataPinsFromNode(next, eventId),
    idFactory: extras?.idFactory,
  });
}

/** Data output pins stored on an event node (custom Outputs or catalog). */
export function eventDataPinsFromNode(
  graph: SerializedGraph,
  eventNodeId: string,
): GraphClassMemberPin[] {
  const node = graph.nodes.find((entry) => entry.id === eventNodeId);
  if (!node) return [];
  if (Array.isArray(node.data.pins)) {
    return (node.data.pins as GraphClassMemberPin[]).filter(
      (pin) => pin.direction !== "in" && pin.typeId !== "exec",
    );
  }
  return [];
}

export function callParentNodeId(
  eventType: string,
  eventName?: string,
): string {
  if (eventType === "flow.event.custom") {
    const slug = formatEventMemberName(eventName ?? "Custom")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `call-parent-custom-${slug || "event"}`;
  }
  return `call-parent-${eventType.replace(/\./g, "-")}`;
}

export function callParentDisplayTitle(
  eventType: string,
  eventName?: string,
): string {
  if (eventType === "flow.event.custom") {
    const body = formatEventMemberName(eventName ?? "Event");
    return `Call ${body || "Event"} Parent`;
  }
  const titled = NATIVE_EVENT_TITLES[eventType];
  const body = titled
    ? formatEventMemberName(titled)
    : formatEventMemberName(
        eventType.startsWith("flow.event.")
          ? eventType.slice("flow.event.".length)
          : eventType,
      );
  return `Call ${body || "Event"} Parent`;
}

/**
 * Insert Call Parent for an event if missing, and default-wire Event → Call Parent
 * when neither side already has conflicting exec/data edges for those pins.
 */
export function ensureCallParentForEvent(
  graph: SerializedGraph,
  options: {
    eventNodeId: string;
    eventType: string;
    eventName?: string;
    parentClassId: string;
    pins?: GraphClassMemberPin[];
    idFactory?: () => string;
  },
): SerializedGraph {
  const parentClassId = options.parentClassId.trim();
  if (!parentClassId) return graph;
  const eventNode = graph.nodes.find((node) => node.id === options.eventNodeId);
  if (!eventNode) return graph;

  const callId = callParentNodeId(options.eventType, options.eventName);
  const existingCall = graph.nodes.find(
    (node) =>
      node.id === callId ||
      (node.type === "flow.event.callParent" &&
        node.data.eventType === options.eventType &&
        (options.eventType !== "flow.event.custom" ||
          formatEventMemberName(String(node.data.eventName ?? "")) ===
            formatEventMemberName(options.eventName ?? ""))),
  );
  const pins = (options.pins ?? eventDataPinsFromNode(graph, options.eventNodeId)).filter(
    (pin) => pin.typeId !== "exec" && pin.direction !== "in",
  );
  let next = graph;
  if (!existingCall) {
    next = {
      ...next,
      nodes: [
        ...next.nodes,
        {
          id: callId,
          type: "flow.event.callParent",
          position: {
            x: eventNode.position.x + 280,
            y: eventNode.position.y,
          },
          data: {
            title: callParentDisplayTitle(options.eventType, options.eventName),
            eventType: options.eventType,
            eventName:
              options.eventType === "flow.event.custom"
                ? formatEventMemberName(options.eventName ?? "Event")
                : formatEventMemberName(
                    NATIVE_EVENT_TITLES[options.eventType] ?? options.eventType,
                  ),
            parentClassId,
            pins,
            __nodeType: "flow.event.callParent",
          },
        },
      ],
    };
  }
  const callNodeId = existingCall?.id ?? callId;
  const edges = [...(next.edges ?? [])];
  const hasExecOut = edges.some(
    (edge) =>
      edge.source === options.eventNodeId &&
      (edge.sourceHandle === "execOut" || edge.sourceHandle === "then"),
  );
  const hasExecIn = edges.some(
    (edge) =>
      edge.target === callNodeId &&
      (edge.targetHandle === "execIn" || edge.targetHandle === "exec"),
  );
  if (!hasExecOut && !hasExecIn) {
    edges.push({
      id: `e:${options.eventNodeId}:execOut:${callNodeId}:execIn`,
      source: options.eventNodeId,
      target: callNodeId,
      sourceHandle: "execOut",
      targetHandle: "execIn",
    });
  }
  for (const pinId of callParentArgPinIds(next, options.eventNodeId, callNodeId)) {
    const hasDataOut = edges.some(
      (edge) =>
        edge.source === options.eventNodeId && edge.sourceHandle === pinId,
    );
    const hasDataIn = edges.some(
      (edge) => edge.target === callNodeId && edge.targetHandle === pinId,
    );
    if (hasDataOut || hasDataIn) continue;
    edges.push({
      id: `e:${options.eventNodeId}:${pinId}:${callNodeId}:${pinId}`,
      source: options.eventNodeId,
      target: callNodeId,
      sourceHandle: pinId,
      targetHandle: pinId,
    });
  }
  return { ...next, edges };
}

/**
 * Pin ids an event output and its Call Parent argument share: a catalog
 * event's own output ids, or a custom event's signature pin ids. Only ids the
 * event node also outputs are wired.
 */
function callParentArgPinIds(
  graph: SerializedGraph,
  eventNodeId: string,
  callNodeId: string,
): string[] {
  const dataPinIds = (
    node: SerializedGraph["nodes"][number] | undefined,
    direction: "in" | "out",
  ): string[] | null => {
    const def = node && flowNodes.find((entry) => entry.id === node.type);
    if (!def) return null;
    return def.pins(node.data)
      .filter((pin) => pin.kind === "data" && pin.direction === direction)
      .map((pin) => pin.id);
  };
  const callIds = dataPinIds(graph.nodes.find((node) => node.id === callNodeId), "in") ?? [];
  const eventIds = dataPinIds(graph.nodes.find((node) => node.id === eventNodeId), "out");
  return eventIds ? callIds.filter((id) => eventIds.includes(id)) : callIds;
}

/** Inherited custom events from parent graphs (ancestor-first). */
export function inheritedCustomEventSeeds(
  options?: ClassEventOptions,
): Array<{ name: string; pins: GraphClassMemberPin[] }> {
  if (!options?.parentGraphs) return [];
  const parentOf =
    options.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const chain: string[] = [];
  let current = options.parentClass ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf(current) ?? null;
  }
  const rows: Array<{ name: string; pins: GraphClassMemberPin[] }> = [];
  const seenNames = new Set<string>();
  for (const className of chain) {
    const parentGraph = options.parentGraphs[className];
    if (!parentGraph) continue;
    for (const member of parentGraph.members ?? []) {
      if (member.kind !== "event") continue;
      const name = formatEventMemberName(member.name);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      rows.push({
        name,
        pins: (member.pins ?? []).filter(
          (pin) => pin.typeId !== "exec" && pin.direction !== "in",
        ),
      });
    }
    for (const node of parentGraph.nodes) {
      if (node.type !== "flow.event.custom") continue;
      const raw =
        typeof node.data.name === "string"
          ? node.data.name
          : typeof node.data.title === "string"
            ? node.data.title
            : "";
      const name = formatEventMemberName(raw);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      const pins = Array.isArray(node.data.pins)
        ? (node.data.pins as GraphClassMemberPin[]).filter(
            (pin) => pin.typeId !== "exec" && pin.direction !== "in",
          )
        : [];
      rows.push({ name, pins });
    }
  }
  return rows;
}

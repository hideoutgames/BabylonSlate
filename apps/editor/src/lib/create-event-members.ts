import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import { walkAncestry } from "@haptic/editor-kit";
import { delegateOf, isAssignable, pinTypeForVariable, type ClassHierarchy, type PinType } from "@haptic/scripting";
import { customEventRows } from "../services/graph-class-symbols";

/** A custom event or function Create Event can turn into a delegate. */
export type CreateEventCandidate = {
  id: string;
  kind: "event" | "function";
  name: string;
  /** The Class declaring it. */
  classId: string;
  /** Declared by the graph's own Class or a parent, so Object can read Self. */
  implicitSelf: boolean;
  /** Its parameters, as Create Event's signature rows. */
  pins: GraphClassMemberPin[];
};

function asInputs(pins: readonly GraphClassMemberPin[]): GraphClassMemberPin[] {
  return pins
    .filter((pin) => pin.typeId !== "exec")
    .map((pin) => ({ ...pin, direction: "in" as const }));
}

/**
 * What Create Event can point at on an Object of `objectClassId`: the custom
 * events and functions of that Class and its parents. A function that returns
 * values cannot be bound, as in Unreal. With `delegate`, only members whose
 * parameters it can pass are listed.
 */
export function createEventCandidates(options: {
  objectClassId: string;
  ownClassId?: string;
  graphs: Readonly<Record<string, SerializedGraph | undefined>>;
  parentOf: (id: string) => string | null | undefined;
  delegate?: PinType;
  hierarchy?: ClassHierarchy;
}): CreateEventCandidate[] {
  const own = new Set(options.ownClassId ? walkAncestry(options.ownClassId, options.parentOf) : []);
  const candidates: CreateEventCandidate[] = [];
  const seen = new Set<string>();
  for (const classId of walkAncestry(options.objectClassId, options.parentOf)) {
    const graph = options.graphs[classId];
    if (!graph) continue;
    const implicitSelf = own.has(classId);
    for (const event of customEventRows(graph)) {
      const key = `event:${event.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ id: `${key}:${classId}`, kind: "event", name: event.name, classId, implicitSelf, pins: asInputs(event.pins) });
    }
    for (const member of graph.members ?? []) {
      if (member.kind !== "function") continue;
      const pins = member.pins ?? [];
      if (pins.some((pin) => pin.direction === "out" && pin.typeId !== "exec")) continue;
      const key = `function:${member.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        id: `${key}:${classId}`,
        kind: "function",
        name: member.name,
        classId,
        implicitSelf,
        pins: asInputs(pins.filter((pin) => pin.direction === "in")),
      });
    }
  }
  const delegate = options.delegate;
  if (delegate?.kind !== "delegate") return candidates;
  return candidates.filter((candidate) =>
    isAssignable(delegateOf(candidate.pins.map((pin) => pinTypeForVariable(pin))), delegate, {
      hierarchy: options.hierarchy,
    }));
}

/** Create Event's node data once `candidate` is picked. */
export function createEventPickData(candidate: CreateEventCandidate): Record<string, unknown> {
  return {
    memberName: candidate.name,
    memberKind: candidate.kind,
    classId: candidate.classId,
    implicitSelf: candidate.implicitSelf,
    pins: candidate.pins,
  };
}

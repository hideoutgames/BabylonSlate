import {
  defaultTimelineValue,
  parseOverlayVisualStyle,
  quaternionToEulerDegrees,
  supportsOverlayVisualStyle,
  timelineValueTypeFor,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type TimelinePropertyTrack,
  type TimelineValueType,
} from "@haptic/core";
import { humanizePropertyLabel, walkAncestry } from "@haptic/editor-kit";
import { engineScriptApiFor, isTimelineAnimatableComponentProperty } from "@haptic/object-model";
import { defaultComponentAuthoringProperties } from "@haptic/runtime/component-authoring";
import { sceneComponentTitle } from "./scene-component-entries";

/**
 * What Add Track offers for one actor: its transform and visibility, its
 * Class variables, and the properties of its components that Play applies
 * live (`isTimelineAnimatableComponentProperty`).
 */

export type TimelineTrackTarget = TimelinePropertyTrack["target"];

export interface TimelinePropertyEntry {
  target: TimelineTrackTarget;
  valueType: TimelineValueType;
  label: string;
}

export interface TimelinePropertyGroup {
  /** `actor`, `variables`, or `component:<id>`. */
  id: string;
  kind: "actor" | "variables" | "component";
  label: string;
  componentClassId?: string;
  entries: TimelinePropertyEntry[];
}

export interface TimelinePropertyContext {
  /** Class graphs by class id, for Class variables (inherited ones included). */
  graphs: Readonly<Record<string, SerializedGraph>>;
  parentOf: (classId: string) => string | null | undefined;
  /** The actor Class's name, for the Class variables heading. */
  classLabel?: string;
}

/** One key per target, used to tell which properties already have a track. */
export function timelineTargetKey(target: TimelineTrackTarget): string {
  return `${target.kind}:${target.componentId ?? ""}:${target.property}`;
}

const ACTOR_ENTRIES: readonly TimelinePropertyEntry[] = [
  { target: { kind: "transform", property: "location" }, valueType: "vec3", label: "Location" },
  { target: { kind: "transform", property: "rotation" }, valueType: "rotator", label: "Rotation" },
  { target: { kind: "transform", property: "scale" }, valueType: "vec3", label: "Scale" },
  { target: { kind: "visible", property: "visible" }, valueType: "bool", label: "Visible" },
];

function classVariables(classId: string, context: TimelinePropertyContext) {
  const seen = new Set<string>();
  const variables: Array<{ name: string; valueType: TimelineValueType; defaultValue: unknown }> = [];
  // Nearest class first, so a child's variable wins over an ancestor's of the same name.
  for (const id of walkAncestry(classId, context.parentOf)) {
    for (const member of context.graphs[id]?.members ?? []) {
      if (member.kind !== "variable" || member.functionId || seen.has(member.name)) continue;
      if ((member.container ?? "single") !== "single") continue;
      const valueType = timelineValueTypeFor(member.typeId);
      if (!valueType) continue;
      seen.add(member.name);
      variables.push({ name: member.name, valueType, defaultValue: member.defaultValue });
    }
  }
  return variables;
}

/** The label a component shows in Add Track and the track list: its name, or its class. */
export function timelineComponentLabel(component: Pick<SerializedComponent, "classId" | "name">): string {
  return component.name?.trim() || humanizePropertyLabel(sceneComponentTitle(component.classId));
}

export function timelinePropertyGroups(actor: SerializedActor, context: TimelinePropertyContext): TimelinePropertyGroup[] {
  const groups: TimelinePropertyGroup[] = [{ id: "actor", kind: "actor", label: "Actor", entries: [...ACTOR_ENTRIES] }];
  const variables = classVariables(actor.classId, context);
  if (variables.length > 0) {
    groups.push({
      id: "variables",
      kind: "variables",
      label: `${context.classLabel ?? humanizePropertyLabel(actor.classId)} (Class Variables)`,
      entries: variables.map((variable) => ({
        target: { kind: "variable", property: variable.name },
        valueType: variable.valueType,
        label: humanizePropertyLabel(variable.name),
      })),
    });
  }
  for (const component of actor.components) {
    const entries = (engineScriptApiFor(component.classId)?.variables ?? [])
      .filter((variable) => isTimelineAnimatableComponentProperty(component.classId, variable))
      .map((variable): TimelinePropertyEntry => ({
        target: { kind: "component", componentId: component.id, property: variable.propertyKey },
        valueType: timelineValueTypeFor(variable.typeId)!,
        label: variable.name,
      }));
    if (entries.length === 0) continue;
    groups.push({
      id: `component:${component.id}`,
      kind: "component",
      label: `${timelineComponentLabel(component)} (${humanizePropertyLabel(component.classId)})`,
      componentClassId: component.classId,
      entries,
    });
  }
  return groups;
}

/** The entry for an existing track's target, for its label; undefined when the actor no longer has it. */
export function timelinePropertyEntry(
  actor: SerializedActor,
  target: TimelineTrackTarget,
  context: TimelinePropertyContext,
): TimelinePropertyEntry | undefined {
  const key = timelineTargetKey(target);
  for (const group of timelinePropertyGroups(actor, context)) {
    const entry = group.entries.find((candidate) => timelineTargetKey(candidate.target) === key);
    if (entry) return entry;
  }
  return undefined;
}

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A stored value (array or script object) as a key value of `valueType`. */
export function timelineKeyValue(valueType: TimelineValueType, stored: unknown): unknown {
  if (stored === undefined) return defaultTimelineValue(valueType);
  const list = Array.isArray(stored) ? stored : null;
  const object = stored && typeof stored === "object" && !list ? (stored as Record<string, unknown>) : null;
  const pick = (index: number, name: string, fallback = 0) => num(list ? list[index] : object?.[name], fallback);
  switch (valueType) {
    case "float": return num(stored);
    case "int": return Math.round(num(stored));
    case "bool": return stored === true;
    case "vec2": return { x: pick(0, "x"), y: pick(1, "y") };
    case "vec3": return { x: pick(0, "x"), y: pick(1, "y"), z: pick(2, "z") };
    case "rotator": return { pitch: pick(0, "pitch"), yaw: pick(1, "yaw"), roll: pick(2, "roll") };
    case "color": return { x: pick(0, "x"), y: pick(1, "y"), z: pick(2, "z"), w: pick(3, "w", 1) };
    case "asset": return typeof stored === "string" ? stored : null;
    default: return typeof stored === "string" ? stored : String(stored ?? "");
  }
}

/**
 * The value a target has in the document (not in a clip), as a key value: what
 * a new key records when the track has no keys to evaluate.
 */
export function authoredTimelineValue(
  actor: SerializedActor,
  target: TimelineTrackTarget,
  valueType: TimelineValueType,
  context: TimelinePropertyContext,
): unknown {
  switch (target.kind) {
    case "transform": {
      const { position, rotation, scale } = actor.transform;
      if (target.property === "rotation") {
        const [pitch, yaw, roll] = quaternionToEulerDegrees(rotation);
        return { pitch, yaw, roll };
      }
      return timelineKeyValue("vec3", target.property === "scale" ? scale : position);
    }
    case "visible":
      return actor.visible !== false;
    case "variable": {
      const stored = actor.properties?.[target.property];
      if (stored !== undefined) return timelineKeyValue(valueType, stored);
      const variable = classVariables(actor.classId, context).find((entry) => entry.name === target.property);
      return timelineKeyValue(valueType, variable?.defaultValue);
    }
    case "component": {
      const component = actor.components.find((entry) => entry.id === target.componentId);
      if (!component) return defaultTimelineValue(valueType);
      const defaults = {
        ...(supportsOverlayVisualStyle(component.classId) ? parseOverlayVisualStyle({}) : {}),
        ...defaultComponentAuthoringProperties(component.classId),
      } as Record<string, unknown>;
      const stored = component.properties[target.property] ?? defaults[target.property];
      return timelineKeyValue(valueType, stored);
    }
  }
}

import type { SerializedComponent, SerializedGraph } from "@babylonslate/core";
import { humanizePropertyLabel, walkAncestry, type PropertyRow } from "@babylonslate/editor-kit";
import type { ComponentPropertyContext } from "./component-property-rows";

/** Includes inherited script fields and preserves authored choices for missing classes. */
export function saveGameVariableNames(classId: string, graphs: Record<string, SerializedGraph>, parentOf: (id: string) => string | null | undefined): string[] {
  return [...new Set(walkAncestry(classId, parentOf).flatMap((id) => (graphs[id]?.members ?? []).filter((member) => member.kind === "variable").map((member) => member.name)))];
}

export function saveGamePropertyRows(actorId: string, component: SerializedComponent, update: (property: string, value: unknown) => void, context: ComponentPropertyContext): PropertyRow[] {
  const selected = Array.isArray(component.properties.actorVariables) ? component.properties.actorVariables.filter((value): value is string => typeof value === "string") : [];
  const byComponent = component.properties.componentVariables && typeof component.properties.componentVariables === "object" ? component.properties.componentVariables as Record<string, string[]> : {};
  const rows: PropertyRow[] = [
    { id: `${component.id}-save-transform`, kind: "boolean", label: "Save Transform", value: component.properties.saveTransform !== false, description: "Save and restore this actor's position, rotation, and scale.", onChange: (value) => update("saveTransform", value) },
    { id: `${component.id}-persist-destruction`, kind: "boolean", label: "Persist Destruction", value: component.properties.persistDestruction !== false, description: "Keep this actor destroyed when loading a later checkpoint.", onChange: (value) => update("persistDestruction", value) },
  ];
  for (const name of new Set([...(context.actorVariableNames?.(actorId) ?? []), ...selected])) rows.push({
    id: `${component.id}-actor-variable-${name}`, kind: "boolean", label: `Save ${humanizePropertyLabel(name)}`, value: selected.includes(name), description: "Actor script variable.",
    onChange: (checked) => update("actorVariables", checked ? [...new Set([...selected, name])] : selected.filter((entry) => entry !== name)),
  });
  for (const target of context.actorComponents?.(actorId) ?? []) {
    if (target.id === component.id) continue;
    const key = target.sourceId ?? target.id;
    const names = Array.isArray(byComponent[key]) ? byComponent[key] : [];
    for (const name of new Set([...(context.componentVariableNames?.(target.classId) ?? []), ...names])) rows.push({
      id: `${component.id}-${key}-variable-${name}`, kind: "boolean", label: `Save ${humanizePropertyLabel(target.classId.replace(/Component$/, ""))} ${humanizePropertyLabel(name)}`, value: names.includes(name), description: `Script variable on ${humanizePropertyLabel(target.classId)} (${key}).`,
      onChange: (checked) => update("componentVariables", { ...byComponent, [key]: checked ? [...new Set([...names, name])] : names.filter((entry) => entry !== name) }),
    });
  }
  return rows;
}

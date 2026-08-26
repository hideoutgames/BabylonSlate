import type { GraphClassMember, SerializedGraph } from "@babylonslate/core";
import { prefabComponentLabel } from "../panels/add-component-catalog";
import {
  mergePrefabComponents,
  type PrefabComponentView,
} from "./prefab-preview";

export type ComponentGraphMember = GraphClassMember & {
  componentId: string;
  inheritedFrom?: string;
};

function uniquifyLabels(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if ((counts.get(label) ?? 0) < 2) return label;
    const next = (seen.get(label) ?? 0) + 1;
    seen.set(label, next);
    return next === 1 ? label : `${label} ${next}`;
  });
}

export function componentGraphMembers(options: {
  components: readonly PrefabComponentView[];
  assetLabel?: (guid: string) => string | undefined;
}): ComponentGraphMember[] {
  const labels = uniquifyLabels(
    options.components.map((component) =>
      prefabComponentLabel(component, options.assetLabel),
    ),
  );
  return options.components.map((component, index) => {
    const member: ComponentGraphMember = {
      id: `component:${component.id}`,
      kind: "variable",
      name: labels[index] ?? prefabComponentLabel(component, options.assetLabel),
      typeId: "object",
      typeClassId: component.classId,
      componentId: component.id,
    };
    if (component.inheritedFrom) member.inheritedFrom = component.inheritedFrom;
    return member;
  });
}

/** Same merge as the Prefab / Components dock (root-first ancestors + local). */
export function mergedPrefabViewsForGraph(options: {
  graph?: SerializedGraph | null;
  classId?: string;
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
}): PrefabComponentView[] {
  const parentOf = options.parentOf ?? (() => null);
  const ancestors: Array<{
    classId: string;
    components: NonNullable<SerializedGraph["components"]>;
  }> = [];
  const seen = new Set<string>();
  const chain: string[] = [];
  let current = options.classId
    ? parentOf(options.classId)
    : (options.parentClass ?? null);
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf(current) ?? null;
  }
  for (const id of [...chain].reverse()) {
    const parentGraph = options.parentGraphs?.[id];
    if (!parentGraph?.components?.length) continue;
    ancestors.push({ classId: id, components: parentGraph.components });
  }
  const local = Array.isArray(options.graph?.components)
    ? options.graph.components
    : [];
  return mergePrefabComponents(ancestors, local);
}

export function componentGraphMembersForClass(options: {
  graph?: SerializedGraph | null;
  classId?: string;
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
  assetLabel?: (guid: string) => string | undefined;
}): ComponentGraphMember[] {
  return componentGraphMembers({
    components: mergedPrefabViewsForGraph(options),
    assetLabel: options.assetLabel,
  });
}

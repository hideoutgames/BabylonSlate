import {
  normalizeClassMemberCategory,
  type GraphClassMember,
  type SerializedGraph,
} from "@haptic/core";
import { prefabComponentLabel } from "../panels/add-component-catalog";
import {
  mergePrefabComponents,
  type PrefabComponentView,
} from "./prefab-preview";

/** Class tree category for the automatic component object-ref variables. */
export const COMPONENT_GRAPH_MEMBER_CATEGORY = "Components";

/** The component's object-ref category: Components unless authored; empty is uncategorized. */
export function componentGraphMemberCategory(
  component: { category?: string },
): string | undefined {
  return component.category === undefined
    ? COMPONENT_GRAPH_MEMBER_CATEGORY
    : normalizeClassMemberCategory(component.category);
}

export type ComponentGraphMember = GraphClassMember & {
  componentId: string;
  inheritedFrom?: string;
};

/**
 * The first of each repeated label keeps it; later ones take the next free
 * ` N` suffix, skipping any label a component already shows (a component
 * renamed "3D Text 2" beside two "3D Text" rows), so every name is unique.
 */
function uniquifyLabels(labels: readonly string[]): string[] {
  const shown = new Set(labels);
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return labels.map((label) => {
    let unique = label;
    if (used.has(label)) {
      let suffix = nextSuffix.get(label) ?? 2;
      while (used.has(`${label} ${suffix}`) || shown.has(`${label} ${suffix}`)) suffix += 1;
      nextSuffix.set(label, suffix + 1);
      unique = `${label} ${suffix}`;
    }
    used.add(unique);
    return unique;
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
    const category = componentGraphMemberCategory(component);
    if (category) member.category = category;
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

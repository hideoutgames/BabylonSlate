import type { SerializedGraph } from "@haptic/core";
import { formatEventMemberName } from "@haptic/editor-kit";
import { jsIdent } from "@haptic/scripting-nodes";

/**
 * Names collide when they compile to one identifier (the validator's rule) or
 * differ only in case (the rename rule).
 */
export function eventNameKeys(data: Record<string, unknown>): string[] {
  const name = formatEventMemberName(String(data.name ?? data.title ?? "")).toLowerCase();
  return [
    ...(typeof data.name === "string" && data.name ? [`id:${jsIdent(data.name)}`] : []),
    ...(name ? [`name:${name}`] : []),
  ];
}

/** The names every custom event of a Class claims: its Event Graph, function graphs and event members. */
export function takenCustomEventNames(graph: SerializedGraph | null | undefined): Set<string> {
  const taken = new Set<string>();
  if (!graph) return taken;
  for (const slice of [graph, ...Object.values(graph.functionGraphs ?? {})]) {
    for (const node of slice.nodes) {
      if (node.type !== "flow.event.custom") continue;
      for (const key of eventNameKeys(node.data)) taken.add(key);
    }
  }
  for (const member of graph.members ?? []) {
    if (member.kind !== "event") continue;
    for (const key of eventNameKeys({ name: member.name })) taken.add(key);
  }
  return taken;
}

/**
 * `name` when no custom event uses it, else the first free `name_1`, `name_2`,
 * …, numbered from its stem so a copy of `Open Door_1` is `Open Door_2`, never
 * `Open Door_1_1`. Two custom events of a Class never share a name.
 */
export function freeCustomEventName(name: string, taken: ReadonlySet<string>): string {
  const formatted = formatEventMemberName(name);
  const isFree = (candidate: string) =>
    eventNameKeys({ name: candidate }).every((key) => !taken.has(key));
  if (isFree(formatted)) return formatted;
  const stem = formatted.replace(/_\d+$/, "");
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}_${index}`;
    if (isFree(candidate)) return candidate;
  }
}

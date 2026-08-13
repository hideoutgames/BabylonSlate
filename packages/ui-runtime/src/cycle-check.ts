import type { UserInterfaceDocument } from "./types";

export function nestedUiGuidsOf(doc: UserInterfaceDocument): string[] {
  const guids: string[] = [];
  for (const widget of Object.values(doc.widgets)) {
    if (widget.nestedUiGuid) guids.push(widget.nestedUiGuid);
    if (widget.visualOverrideGuid) guids.push(widget.visualOverrideGuid);
  }
  return guids;
}

/**
 * Depth-first cycle check over nested UserInterface refs.
 * Returns the guid path that loops, or null when the graph is a DAG.
 */
export function findUiReferenceCycle(
  rootGuid: string,
  getNestedGuids: (guid: string) => readonly string[],
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const walk = (guid: string): string[] | null => {
    if (visiting.has(guid)) {
      const start = path.indexOf(guid);
      return [...path.slice(start), guid];
    }
    if (visited.has(guid)) return null;
    visiting.add(guid);
    path.push(guid);
    for (const child of getNestedGuids(guid)) {
      const cycle = walk(child);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(guid);
    visited.add(guid);
    return null;
  };

  return walk(rootGuid);
}

export function uiDocumentWouldCycle(
  selfGuid: string,
  doc: UserInterfaceDocument,
  resolve: (guid: string) => UserInterfaceDocument | null,
): string[] | null {
  return findUiReferenceCycle(selfGuid, (guid) => {
    if (guid === selfGuid) return nestedUiGuidsOf(doc);
    const nested = resolve(guid);
    return nested ? nestedUiGuidsOf(nested) : [];
  });
}

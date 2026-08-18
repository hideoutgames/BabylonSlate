import { createWidget, type UserInterfaceDocument } from "./types";

export function nestedUiGuidsOf(doc: UserInterfaceDocument): string[] {
  const guids: string[] = [];
  for (const widget of Object.values(doc.widgets)) {
    if (widget.nestedUiGuid) guids.push(widget.nestedUiGuid);
    if (widget.visualOverrideGuid) guids.push(widget.visualOverrideGuid);
  }
  return guids;
}

function withNestedTrial(
  doc: UserInterfaceDocument,
  nestedGuid: string,
): UserInterfaceDocument {
  const trialId = "__nested-trial__";
  const host = doc.widgets[doc.rootId];
  if (!host) return doc;
  return {
    ...doc,
    widgets: {
      ...doc.widgets,
      [trialId]: {
        ...createWidget(trialId, "UserInterface", "Nested", host.layout),
        style: host.style,
        nestedUiGuid: nestedGuid,
      },
      [host.id]: { ...host, children: [...host.children, trialId] },
    },
  };
}

/**
 * UserInterface guids that can be nested into `doc` without a self-cycle.
 */
export function nestedUiPickableGuids(
  selfGuid: string,
  candidateGuids: readonly string[],
  doc: UserInterfaceDocument,
  resolve: (guid: string) => UserInterfaceDocument | null,
): string[] {
  return candidateGuids.filter((guid) => {
    if (guid === selfGuid) return false;
    return uiDocumentWouldCycle(selfGuid, withNestedTrial(doc, guid), resolve) ===
      null;
  });
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

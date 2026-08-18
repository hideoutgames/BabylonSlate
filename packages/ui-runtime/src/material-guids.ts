import type { UserInterfaceDocument } from "./types";
import { nestedUiGuidsOf } from "./cycle-check";

/** Interface material asset guids referenced by Material widgets. */
export function collectMaterialGuidsFromUiDocuments(
  documents: Iterable<UserInterfaceDocument>,
  resolveNested?: (guid: string) => UserInterfaceDocument | null,
): string[] {
  const guids = new Set<string>();
  const seenDocs = new Set<UserInterfaceDocument>();
  const queue = [...documents];
  while (queue.length > 0) {
    const doc = queue.shift()!;
    if (seenDocs.has(doc)) continue;
    seenDocs.add(doc);
    for (const widget of Object.values(doc.widgets)) {
      const fromProps = widget.props.materialGuid;
      if (typeof fromProps === "string" && fromProps.length > 0) {
        guids.add(fromProps);
      }
    }
    if (!resolveNested) continue;
    for (const nestedGuid of nestedUiGuidsOf(doc)) {
      const nested = resolveNested(nestedGuid);
      if (nested) queue.push(nested);
    }
  }
  return [...guids];
}

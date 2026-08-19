import { userInterfaceClassId } from "@babylonslate/core";
import { asUiDocument } from "./play-content";

export type NestedUiLogicSource = {
  slotId: string;
  guid: string;
  path: string;
  payload: unknown;
};

export type NestedUiSlot = {
  slotId: string;
  classId: string;
};

export function nestedUiSlots(
  nested: readonly NestedUiLogicSource[],
): NestedUiSlot[] {
  return nested.map((entry) => ({
    slotId: entry.slotId,
    classId: userInterfaceClassId(entry.guid),
  }));
}

/** Nested UserInterface payloads reachable from a host widget tree. */
export function collectNestedUiLogicSources(
  payload: unknown,
  resolve: (guid: string) => { path: string; payload: unknown } | null,
): NestedUiLogicSource[] {
  const sources: NestedUiLogicSource[] = [];
  const seen = new Set<string>();
  const visit = (docPayload: unknown, prefix: string) => {
    const doc = asUiDocument(docPayload);
    for (const widget of Object.values(doc.widgets)) {
      const nestedGuid =
        widget.kind === "UserInterface" ? widget.nestedUiGuid?.trim() : undefined;
      if (!nestedGuid || seen.has(nestedGuid)) continue;
      seen.add(nestedGuid);
      const resolved = resolve(nestedGuid);
      if (!resolved) continue;
      const slotId = prefix ? `${prefix}/${widget.id}` : widget.id;
      sources.push({
        slotId,
        guid: nestedGuid,
        path: resolved.path,
        payload: resolved.payload,
      });
      visit(resolved.payload, slotId);
    }
  };
  visit(payload, "");
  return sources;
}

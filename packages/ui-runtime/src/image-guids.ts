import type { UserInterfaceDocument } from "./types";

/** Texture asset guids referenced by Image widgets in UI / EUI documents. */
export function collectImageGuidsFromUiDocuments(
  documents: Iterable<UserInterfaceDocument>,
): string[] {
  const guids = new Set<string>();
  for (const doc of documents) {
    for (const widget of Object.values(doc.widgets)) {
      const fromProps = widget.props.imageGuid;
      const fromStyle = widget.style.imageGuid;
      if (typeof fromProps === "string" && fromProps.length > 0) {
        guids.add(fromProps);
      }
      if (typeof fromStyle === "string" && fromStyle.length > 0) {
        guids.add(fromStyle);
      }
    }
  }
  return [...guids];
}

import { useSyncExternalStore } from "react";

/**
 * A clip another window asked a Scene or Scene Layer document to show
 * (Timeline Asset › Open). The document's Clips window selects it, then clears
 * the request.
 */
const requests = new Map<string, string>();
const listeners = new Set<() => void>();

export function requestTimelineClipFocus(documentId: string, clipId: string): void {
  requests.set(documentId, clipId);
  for (const listener of listeners) listener();
}

export function takeTimelineClipFocus(documentId: string): string | undefined {
  const clipId = requests.get(documentId);
  requests.delete(documentId);
  return clipId;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The clip this document has been asked to show, if any; read it with `takeTimelineClipFocus`. */
export function usePendingTimelineClipFocus(documentId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => requests.get(documentId), () => undefined);
}

import { isPreviewPackMessage as isPackMessage, type PreviewPackMessage } from "@haptic/exporter";

/**
 * The origin of the page embedding this player, which every Preview message
 * must come from and is posted to. The desktop app runs the player at its own
 * origin, apart from the editor's; the browser reports the embedder in
 * `ancestorOrigins`, which the page cannot change. Without it (a host that
 * lacks the list, or an opaque embedder) the player trusts only its own origin.
 */
export function previewHostOrigin(location: Pick<Location, "origin"> & { ancestorOrigins?: { readonly length: number; readonly [index: number]: string } }): string {
  const embedder = location.ancestorOrigins && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : undefined;
  return embedder && embedder !== "null" ? embedder : location.origin;
}

export function isExpectedPreviewHostMessage(
  event: Pick<MessageEvent, "source" | "origin">,
  parentWindow: Window,
  expectedOrigin: string,
): boolean {
  return event.source === parentWindow && event.origin === expectedOrigin;
}

export function previewPackFromExpectedHostMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  parentWindow: Window,
  expectedOrigin: string,
): PreviewPackMessage | null {
  if (!isExpectedPreviewHostMessage(event, parentWindow, expectedOrigin)) return null;
  const pack: unknown = event.data;
  return isPackMessage(pack) ? pack : null;
}

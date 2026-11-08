import { isPreviewPackMessage as isPackMessage, type PreviewPackMessage } from "@haptic/exporter";

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

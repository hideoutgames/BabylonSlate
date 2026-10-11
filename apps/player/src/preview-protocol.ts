export {
  PREVIEW_REQUEST_PACK_MESSAGE,
  PREVIEW_READY_MESSAGE,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_ERROR_MESSAGE,
  PREVIEW_STOP_MESSAGE,
  filesFromPreviewPack,
} from "@babylonslate/exporter";
import { isPreviewPackMessage as isPackMessage, type PreviewPackMessage } from "@babylonslate/exporter";

export function isExpectedPreviewHostMessage(
  event: Pick<MessageEvent, "source" | "origin">,
  parentWindow: Window,
  expectedOrigin: string,
): boolean {
  return event.source === parentWindow && event.origin === expectedOrigin;
}

/** The Preview handoff: the catalog only, assets on demand, and the session's trace budget. */
export type PreviewHandoff = PreviewPackMessage & { onDemand: true; traceByteBudget: number };

export function previewPackFromExpectedHostMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  parentWindow: Window,
  expectedOrigin: string,
): PreviewHandoff | null {
  if (!isExpectedPreviewHostMessage(event, parentWindow, expectedOrigin)) return null;
  const pack: unknown = event.data;
  return isPackMessage(pack) && pack.onDemand === true && pack.traceByteBudget !== undefined
    ? pack as PreviewHandoff : null;
}

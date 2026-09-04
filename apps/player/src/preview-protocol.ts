export {
  PREVIEW_PACK_MESSAGE,
  PREVIEW_REQUEST_PACK_MESSAGE,
  PREVIEW_READY_MESSAGE,
  PREVIEW_STATS_MESSAGE,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_ERROR_MESSAGE,
  PREVIEW_STOP_MESSAGE,
  isPreviewPackMessage,
  filesFromPreviewPack,
  previewPackFromFiles,
} from "@babylonslate/exporter";
export type {
  PreviewPackMessage,
  PreviewRequestPackMessage,
  PreviewReadyMessage,
  PreviewStatsMessage,
  PreviewDiagnosticsMessage,
  PreviewErrorMessage,
} from "@babylonslate/exporter";
import { isPreviewPackMessage as isPackMessage, type PreviewPackMessage } from "@babylonslate/exporter";

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
  return isPackMessage(event.data) ? event.data : null;
}

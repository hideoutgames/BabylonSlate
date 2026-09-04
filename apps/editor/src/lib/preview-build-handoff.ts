/**
 * Preview Build posts the in-memory pack into the player iframe. After Stop,
 * the host must not resend it if the iframe reloads or asks again.
 */
export function canSendPreviewPack(options: {
  files: Map<string, Uint8Array> | null | undefined;
  closing: boolean;
}): options is { files: Map<string, Uint8Array>; closing: false } {
  return Boolean(options.files) && !options.closing;
}

export function previewTargetFromSrc(src: string, documentUrl: string): { src: string; origin: string } {
  return { src, origin: new URL(src, documentUrl).origin };
}

export function isExpectedPreviewMessage(
  event: Pick<MessageEvent, "source" | "origin">,
  expectedSource: Window | null | undefined,
  expectedOrigin: string,
): boolean {
  return event.source === expectedSource && event.origin === expectedOrigin;
}

/** Overlay Play, Preparing Preview, and the Preview iframe all own GPU. */
export function editorViewportPausedForSession(options: {
  playing: boolean;
  preparing: boolean;
}): boolean {
  return options.playing || options.preparing;
}

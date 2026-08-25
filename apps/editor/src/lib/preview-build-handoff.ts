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

/** Overlay Play, Preparing Preview, and the Preview iframe all own GPU. */
export function editorViewportPausedForSession(options: {
  playing: boolean;
  preparing: boolean;
}): boolean {
  return options.playing || options.preparing;
}

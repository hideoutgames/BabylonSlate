/** Browser storage key of the `preservebuffer` debug setting. */
const PRESERVE_DRAWING_BUFFER_KEY = "haptic.debug.preserveDrawingBuffer";

/**
 * Whether the project Engine keeps its drawing buffer between presentations: on unless the `preservebuffer off` debug
 * command turned it off. Off is a debug comparison on a device only (WebKit may present a preserved buffer by
 * copying, which can back up behind the compositor): the Engine's own reads (a view's copy, the direct presenter's held
 * image) happen in the task that drew the frame, but in a frame the Engine skips (the frame cap, a held frame) the
 * canvas reads back blank, which fails the direct presentation e2e probe that samples every animation frame. It is a
 * context attribute, so it applies when the project Engine is next created (an editor reload, or reopening the
 * project). Free of Babylon, so Home can read and restore it before any Engine loads.
 */
export function preserveDrawingBufferSetting(): boolean {
  try {
    return globalThis.localStorage?.getItem(PRESERVE_DRAWING_BUFFER_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Debug (`preservebuffer on|off`, and the Feature Test Check's Breakdown A/B): store the setting for the next project Engine. */
export function setPreserveDrawingBufferSetting(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.removeItem(PRESERVE_DRAWING_BUFFER_KEY);
    else globalThis.localStorage?.setItem(PRESERVE_DRAWING_BUFFER_KEY, "off");
  } catch {
    // Storage unavailable (a private window): the setting stays on.
  }
}

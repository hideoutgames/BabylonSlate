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

/**
 * The Preview iframe's sandbox. Project code runs there: it may run scripts
 * and keep its own origin (workers, WebAssembly and storage need one), but
 * never navigate the editor or open forms or dialogs. A player at its own
 * origin (`isolated`, the desktop app) gets nothing of the editor's from
 * `allow-same-origin` and opens no popups, which the main process would hand
 * to the system. A player sharing the editor's origin (web and mobile) keeps
 * opening Open URL in a browser tab.
 */
export function previewFrameSandbox(isolated: boolean): string {
  const base = "allow-scripts allow-same-origin allow-pointer-lock";
  return isolated ? base : `${base} allow-popups allow-popups-to-escape-sandbox`;
}

/** Features the Preview frame may use when it runs at another origin than the editor. */
export const PREVIEW_FRAME_ALLOW = "fullscreen; gamepad; autoplay; cross-origin-isolated";

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

/**
 * Copy To Clipboard and Open URL reach the browser here, on the main thread. Like
 * device vibration, a browser that refuses (no recent tap, a popup blocker, a denied
 * clipboard permission, an embedded view without the API) leaves the game running;
 * a refusal is never a game error.
 */

type ClipboardLike = { writeText?: (text: string) => Promise<void> } | undefined;
type OpenWindow = ((url: string, target: string, features: string) => unknown) | undefined;

/** Write `text` to the system clipboard, where the browser allows it. */
export function applyClipboardWrite(
  command: { text: string },
  clipboard: ClipboardLike = typeof navigator === "undefined" ? undefined : navigator.clipboard,
): void {
  try {
    void clipboard?.writeText?.(command.text)?.catch(() => {
      // Refused: no recent user activation, or no clipboard permission.
    });
  } catch {
    // Some embedded views throw instead of rejecting.
  }
}

/**
 * Open an http or https address in a new tab (the desktop app hands it to the system
 * browser). The runtime already refuses other schemes; this check keeps a forged command
 * from opening `javascript:` or file addresses in the host page.
 */
export function applyOpenUrl(
  command: { url: string },
  open: OpenWindow = typeof window === "undefined" ? undefined : window.open.bind(window),
): void {
  let url: URL;
  try {
    url = new URL(command.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  try {
    open?.(url.href, "_blank", "noopener,noreferrer");
  } catch {
    // A blocked popup returns null in most browsers; a few embedded views throw.
  }
}

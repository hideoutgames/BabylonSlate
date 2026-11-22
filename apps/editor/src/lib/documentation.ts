/**
 * The published documentation site. The desktop app's main process allows it in `externalOpenUrl`
 * (apps/desktop/src/packaged-security.ts), so the editor can hand it to the system browser.
 */
export const HAPTIC_DOCS_URL = "https://hideoutgames.github.io/BabylonSlate/docs/";

type OpenWindow = (url: string, target: string, features: string) => unknown;

/** Opens the documentation outside the editor: a new browser tab on the web, the system browser in the apps. */
export function openDocumentation(open: OpenWindow = window.open.bind(window)): void {
  open(HAPTIC_DOCS_URL, "_blank", "noopener,noreferrer");
}

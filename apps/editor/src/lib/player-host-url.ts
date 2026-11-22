import { getHostPlatform } from "@haptic/vfs";

/**
 * Preview Build hosts `apps/player` beside the editor bundle. Paths must follow
 * the Vite base, otherwise a deployed sub-path (GitHub Pages serves the editor
 * from `/BabylonSlate/`) requests `/player/` at the domain root and the iframe
 * loads nothing but its own black background.
 */
export function playerHostBase(
  base: string = import.meta.env.BASE_URL ?? "/",
): string {
  const root = base.trim() === "" ? "/" : base;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return `${prefix}player/`;
}

/** The desktop app serves the Preview player at its own origin, apart from the editor's `app://babylonslate`. */
export const DESKTOP_PREVIEW_ORIGIN = "app://preview";

/** Where this host's Preview player runs: its own origin on desktop, the editor's origin (null) elsewhere. */
export function previewPlayerOrigin(): string | null {
  return getHostPlatform() === "electron" ? DESKTOP_PREVIEW_ORIGIN : null;
}

export function playerPreviewSrc(
  cacheBust: number,
  base?: string,
  origin: string | null = previewPlayerOrigin(),
): string {
  return `${origin ?? ""}${playerHostBase(base)}index.html?preview=1&t=${cacheBust}`;
}

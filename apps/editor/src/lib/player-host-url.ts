import { getHostPlatform } from "@haptic/vfs";
import { playerHostBase } from "./player-host-base";

export { playerHostBase };

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

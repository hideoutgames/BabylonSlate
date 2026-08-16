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

export function playerPreviewSrc(cacheBust: number, base?: string): string {
  return `${playerHostBase(base)}index.html?preview=1&t=${cacheBust}`;
}

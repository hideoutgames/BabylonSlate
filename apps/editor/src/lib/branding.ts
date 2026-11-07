/** Public path for the Haptic wordmark copied from `engine-logos/` into `public/branding/`. */

/**
 * The wordmark with the chromatic fringes of haptic.no's title. Haptic is dark
 * only, so the light-ink dark-mode wordmark is the only one served.
 */
const BRAND_WORDMARK = "branding/HapticWordmark-DarkMode.png";

export function publicAssetUrl(pathFromPublic: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${pathFromPublic.replace(/^\//, "")}`;
}

export function brandWordmarkSrc(): string {
  return publicAssetUrl(BRAND_WORDMARK);
}

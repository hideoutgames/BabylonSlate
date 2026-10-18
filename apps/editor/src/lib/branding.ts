/** Public paths for the Haptic marks copied from `engine-logos/` into `public/branding/`. */

export const BRAND_NAME = "Haptic";

/** Haptic is dark only, so the light-ink dark-mode marks are the only ones served. */
export const BRAND_ICON = "branding/HapticMark-DarkMode.png";
/** The wordmark with the chromatic fringes of haptic.no's title. */
export const BRAND_WORDMARK = "branding/HapticWordmark-DarkMode.png";

export function publicAssetUrl(pathFromPublic: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${pathFromPublic.replace(/^\//, "")}`;
}

export function brandIconSrc(): string {
  return publicAssetUrl(BRAND_ICON);
}

export function brandWordmarkSrc(): string {
  return publicAssetUrl(BRAND_WORDMARK);
}

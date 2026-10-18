/** Public paths for the Haptic marks copied from `engine-logos/` into `public/branding/`. */

export const BRAND_NAME = "Haptic";

/** Light-mode mark (dark ink) — use on light chrome. */
export const BRAND_ICON_ON_LIGHT = "branding/HapticMark-LightMode.png";
/** Dark-mode mark (light ink) — use on dark chrome. */
export const BRAND_ICON_ON_DARK = "branding/HapticMark-DarkMode.png";

export function publicAssetUrl(pathFromPublic: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${pathFromPublic.replace(/^\//, "")}`;
}

export function brandIconSrc(theme: "light" | "dark"): string {
  return publicAssetUrl(
    theme === "dark" ? BRAND_ICON_ON_DARK : BRAND_ICON_ON_LIGHT,
  );
}

/** Wordmarks with the chromatic fringes of haptic.no's title. */
export const BRAND_WORDMARK_ON_LIGHT = "branding/HapticWordmark-LightMode.png";
export const BRAND_WORDMARK_ON_DARK = "branding/HapticWordmark-DarkMode.png";

export function brandWordmarkSrc(theme: "light" | "dark"): string {
  return publicAssetUrl(
    theme === "dark" ? BRAND_WORDMARK_ON_DARK : BRAND_WORDMARK_ON_LIGHT,
  );
}

/** Public paths for Slate brand artwork copied from `engine-logos/`. */

export const BRAND_NAME = "BabylonSlate";

/** Dark-ink wordmark — use on light chrome. */
export const BRAND_LOGO_ON_LIGHT = "branding/SlateLogoDark.png";
/** Light-ink wordmark — use on dark chrome. */
export const BRAND_LOGO_ON_DARK = "branding/SlateLogoLight.png";

export function publicAssetUrl(pathFromPublic: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}${pathFromPublic.replace(/^\//, "")}`;
}

export function brandLogoSrc(theme: "light" | "dark"): string {
  return publicAssetUrl(
    theme === "dark" ? BRAND_LOGO_ON_DARK : BRAND_LOGO_ON_LIGHT,
  );
}

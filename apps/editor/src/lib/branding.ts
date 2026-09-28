/** Public paths for Slate brand artwork copied from `engine-logos/`. */

export const BRAND_NAME = "Slate";

/** Dark-ink mark — use on light chrome. */
export const BRAND_ICON_ON_LIGHT = "branding/SlateIconDark.png";
/** Light-ink mark — use on dark chrome. */
export const BRAND_ICON_ON_DARK = "branding/SlateIconLight.png";

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

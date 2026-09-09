/** Portable project-browser identity, separate from game rendering settings. */
export interface ProjectAppearance {
  /** Identifier in the project browser's icon catalog. */
  icon: string;
  /** Identifier in the project browser's badge color palette. */
  color: string;
  /** Optional small PNG, JPEG, or WebP data URL supplied by the user. */
  image?: string;
}

/** Bounds each cached badge so twenty recents fit within app-settings storage. */
export const MAX_PROJECT_IMAGE_DATA_URL_LENGTH = 96 * 1024;

/** Older projects omit appearance; malformed imported values fall back safely. */
export function normalizeProjectAppearance(
  value: unknown,
): ProjectAppearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { icon, color, image } = value as Record<string, unknown>;
  if (typeof icon !== "string" || typeof color !== "string") return undefined;
  const normalizedIcon = icon.trim();
  const normalizedColor = color.trim();
  if (
    !normalizedIcon ||
    normalizedIcon.length > 64 ||
    !normalizedColor ||
    normalizedColor.length > 64
  ) {
    return undefined;
  }
  const appearance: ProjectAppearance = {
    icon: normalizedIcon,
    color: normalizedColor,
  };
  if (
    typeof image === "string" &&
    image.length <= MAX_PROJECT_IMAGE_DATA_URL_LENGTH &&
    /^data:image\/(png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      image,
    ) &&
    !image.endsWith(",")
  ) {
    appearance.image = image;
  }
  return appearance;
}

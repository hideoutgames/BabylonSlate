/** Portable project-browser identity, separate from game rendering settings. */
export interface ProjectAppearance {
  /** Identifier in the project browser's icon catalog. */
  icon: string;
  /** Identifier in the project browser's badge color palette. */
  color: string;
  /**
   * The user's picture as a PNG, JPEG or WebP data URL, in memory only (cards, the editor's project mark). It is never
   * written to `project.json` or app settings: the project stores its bytes in `coverFile`, and Homepage's recents
   * keep a copy in derived storage (`recentProjectCoverPath`).
   */
  image?: string;
  /** The project-root file holding the picture's bytes; absent without a picture. */
  coverFile?: ProjectCoverFile;
  /** Which thumbnail the card shows when both exist; the picture by default. */
  cover?: "icon" | "image";
}

/** Project-root picture files, one per format, beside `project.json`. */
export const PROJECT_COVER_FILES = ["cover.webp", "cover.jpg", "cover.png"] as const;
export type ProjectCoverFile = (typeof PROJECT_COVER_FILES)[number];

const COVER_FILE_BY_MIME: Readonly<Record<string, ProjectCoverFile>> = {
  "image/webp": "cover.webp", "image/jpeg": "cover.jpg", "image/png": "cover.png",
};
const COVER_MIME_BY_FILE: Readonly<Record<ProjectCoverFile, string>> = {
  "cover.webp": "image/webp", "cover.jpg": "image/jpeg", "cover.png": "image/png",
};

/** Caps a picture's data URL: the editor shrinks pictures to 256 px before keeping them. */
export const MAX_PROJECT_IMAGE_DATA_URL_LENGTH = 96 * 1024;

/** The appearance as stored in `project.json` and app settings: everything but the in-memory picture. */
export function storedProjectAppearance(appearance: ProjectAppearance): ProjectAppearance {
  const stored = { ...appearance };
  delete stored.image;
  return stored;
}

/** The project-root file and bytes of a picture data URL, or null for anything else. */
export function projectCoverFromDataUrl(dataUrl: string): { file: ProjectCoverFile; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  const file = match ? COVER_FILE_BY_MIME[match[1]!] : undefined;
  if (!match || !file) return null;
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { file, bytes };
}

/** A picture's data URL from its stored bytes, for cards and the project mark. */
export function projectCoverDataUrl(file: ProjectCoverFile, bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${COVER_MIME_BY_FILE[file]};base64,${btoa(binary)}`;
}

/** Older projects omit appearance; malformed imported values fall back safely. */
export function normalizeProjectAppearance(
  value: unknown,
): ProjectAppearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { icon, color, image, cover, coverFile } = value as Record<string, unknown>;
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
  if ((PROJECT_COVER_FILES as readonly unknown[]).includes(coverFile)) appearance.coverFile = coverFile as ProjectCoverFile;
  if (cover === "icon" || cover === "image") appearance.cover = cover;
  return appearance;
}

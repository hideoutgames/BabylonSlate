import {
  BoxIcon,
  CarIcon,
  CastleIcon,
  CrownIcon,
  FlagIcon,
  Gamepad2Icon,
  GhostIcon,
  HeartIcon,
  MountainSnowIcon,
  OrbitIcon,
  PuzzleIcon,
  RocketIcon,
  ShapesIcon,
  SparklesIcon,
  SwordsIcon,
  TreePineIcon,
  type LucideIcon,
} from "lucide-react";
import {
  MAX_PROJECT_IMAGE_DATA_URL_LENGTH,
  type ProjectAppearance,
} from "@haptic/core";

/** New projects start grey with the generic shapes icon. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearance = {
  icon: "shapes",
  color: "stone",
};

/** Project card icons; a picture, when set, replaces the icon. */
export const PROJECT_ICON_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "shapes", label: "Shapes", icon: ShapesIcon },
  { id: "box", label: "Box", icon: BoxIcon },
  { id: "gamepad", label: "Gamepad", icon: Gamepad2Icon },
  { id: "rocket", label: "Rocket", icon: RocketIcon },
  { id: "swords", label: "Swords", icon: SwordsIcon },
  { id: "castle", label: "Castle", icon: CastleIcon },
  { id: "car", label: "Car", icon: CarIcon },
  { id: "ghost", label: "Ghost", icon: GhostIcon },
  { id: "tree", label: "Tree", icon: TreePineIcon },
  { id: "mountain", label: "Mountain", icon: MountainSnowIcon },
  { id: "planet", label: "Planet", icon: OrbitIcon },
  { id: "puzzle", label: "Puzzle", icon: PuzzleIcon },
  { id: "crown", label: "Crown", icon: CrownIcon },
  { id: "heart", label: "Heart", icon: HeartIcon },
  { id: "flag", label: "Flag", icon: FlagIcon },
  { id: "sparkles", label: "Sparkles", icon: SparklesIcon },
];

/** Unknown or older icon ids fall back to the default shapes icon. */
export function projectIconPreset(id: string | undefined) {
  return (
    PROJECT_ICON_PRESETS.find((preset) => preset.id === id) ??
    PROJECT_ICON_PRESETS[0]!
  );
}

export const PROJECT_COLOR_PRESETS = [
  { id: "coral", label: "Crimson" },
  { id: "amber", label: "Gold" },
  { id: "lime", label: "Lime" },
  { id: "mint", label: "Cyan" },
  { id: "sky", label: "Electric Blue" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Magenta" },
  { id: "stone", label: "Stone" },
] as const;

/** Keep user pictures small enough to persist with a project and its recent entry. */
export async function prepareProjectPicture(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP picture.");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Choose a picture smaller than 10 MB.");
  }
  signal?.throwIfAborted();
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanUp = () => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanUp();
        image.src = "";
        reject(new DOMException("Picture import cancelled.", "AbortError"));
      };
      image.onload = () => {
        cleanUp();
        resolve();
      };
      image.onerror = () => {
        cleanUp();
        reject(
          new Error("This picture could not be opened. Try another file."),
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      image.src = url;
    });
    signal?.throwIfAborted();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height)
      throw new Error("This picture has no readable dimensions.");
    const scale = Math.min(1, 256 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Picture import is unavailable in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const [type, quality] of [
      ["image/webp", 0.82],
      ["image/jpeg", 0.72],
    ] as const) {
      const dataUrl = canvas.toDataURL(type, quality);
      if (
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(
          dataUrl,
        ) &&
        dataUrl.length <= MAX_PROJECT_IMAGE_DATA_URL_LENGTH
      )
        return dataUrl;
    }
    throw new Error("This picture is too detailed. Try a smaller picture.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

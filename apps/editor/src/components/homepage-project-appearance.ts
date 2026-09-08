import {
  BoxIcon,
  CastleIcon,
  CompassIcon,
  FlameIcon,
  Gamepad2Icon,
  GemIcon,
  LeafIcon,
  MountainIcon,
  OrbitIcon,
  RocketIcon,
  SparklesIcon,
  WavesIcon,
} from "lucide-react";
import {
  MAX_PROJECT_IMAGE_DATA_URL_LENGTH,
  type ProjectAppearance,
} from "@babylonslate/core";

export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearance = {
  icon: "box",
  color: "stone",
};

export const PROJECT_ICON_PRESETS = [
  { id: "box", label: "Box", icon: BoxIcon },
  { id: "gamepad", label: "Gamepad", icon: Gamepad2Icon },
  { id: "rocket", label: "Rocket", icon: RocketIcon },
  { id: "orbit", label: "Orbit", icon: OrbitIcon },
  { id: "gem", label: "Gem", icon: GemIcon },
  { id: "sparkles", label: "Sparkles", icon: SparklesIcon },
  { id: "mountain", label: "Mountain", icon: MountainIcon },
  { id: "castle", label: "Castle", icon: CastleIcon },
  { id: "compass", label: "Compass", icon: CompassIcon },
  { id: "leaf", label: "Leaf", icon: LeafIcon },
  { id: "waves", label: "Waves", icon: WavesIcon },
  { id: "flame", label: "Flame", icon: FlameIcon },
] as const;

export const PROJECT_COLOR_PRESETS = [
  { id: "coral", label: "Coral" },
  { id: "amber", label: "Amber" },
  { id: "lime", label: "Lime" },
  { id: "mint", label: "Mint" },
  { id: "sky", label: "Sky" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
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

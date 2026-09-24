import {
  MAX_PROJECT_IMAGE_DATA_URL_LENGTH,
  type ProjectAppearance,
} from "@babylonslate/core";

/** The launcher does not display `icon`; the stored format still requires it. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearance = {
  icon: "box",
  color: "sky",
};

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

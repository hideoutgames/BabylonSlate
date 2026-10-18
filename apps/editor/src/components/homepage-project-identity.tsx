import { useState } from "react";
import { ShapesIcon } from "lucide-react";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  DEFAULT_PROJECT_APPEARANCE,
  PROJECT_COLOR_PRESETS,
} from "./homepage-project-appearance";

/** Up to two initials from a project name: "Neon Drift" gives "ND". */
export function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** The user's picture always wins; the placeholder only fills an empty thumbnail. */
function useProjectThumbnail(appearance?: ProjectAppearance, name?: string) {
  const identity =
    normalizeProjectAppearance(appearance) ?? DEFAULT_PROJECT_APPEARANCE;
  const [failedImage, setFailedImage] = useState<string | undefined>();
  const image =
    identity.image && identity.image !== failedImage
      ? identity.image
      : undefined;
  return {
    attributes: {
      "aria-hidden": true,
      "data-has-image": Boolean(image),
    },
    content: image ? (
      <img src={image} alt="" onError={() => setFailedImage(image)} />
    ) : name && projectInitials(name) ? (
      <span className="homepage-project-initials">{projectInitials(name)}</span>
    ) : (
      <ShapesIcon data-placeholder="" />
    ),
  };
}

function projectColor(appearance?: ProjectAppearance): string {
  const color = normalizeProjectAppearance(appearance)?.color;
  return (
    PROJECT_COLOR_PRESETS.find((preset) => preset.id === color)?.id ??
    DEFAULT_PROJECT_APPEARANCE.color
  );
}

/** Compact tile for list rows and inline previews. */
export function ProjectIdentityBadge({
  appearance,
  name,
  className,
}: {
  appearance?: ProjectAppearance;
  name?: string;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance, name);
  return (
    <span
      {...attributes}
      className={cn("homepage-project-badge", className)}
      data-color={projectColor(appearance)}
    >
      {content}
    </span>
  );
}

/** Card thumbnail: the picture edge to edge, or the project colour with its initials. */
export function ProjectCover({
  appearance,
  name,
  className,
}: {
  appearance?: ProjectAppearance;
  name?: string;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance, name);
  return (
    <span
      {...attributes}
      className={cn("homepage-project-cover", className)}
      data-color={projectColor(appearance)}
    >
      {content}
    </span>
  );
}

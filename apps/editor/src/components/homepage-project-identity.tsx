import { useState } from "react";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  DEFAULT_PROJECT_APPEARANCE,
  PROJECT_COLOR_PRESETS,
  projectIconPreset,
} from "./homepage-project-appearance";

/** The user's picture always wins; otherwise the chosen icon fills the thumbnail. */
function useProjectThumbnail(appearance?: ProjectAppearance) {
  const identity =
    normalizeProjectAppearance(appearance) ?? DEFAULT_PROJECT_APPEARANCE;
  const [failedImage, setFailedImage] = useState<string | undefined>();
  const image =
    identity.image && identity.image !== failedImage
      ? identity.image
      : undefined;
  const Icon = projectIconPreset(identity.icon).icon;
  return {
    attributes: {
      "aria-hidden": true,
      "data-has-image": Boolean(image),
    },
    content: image ? (
      <img src={image} alt="" onError={() => setFailedImage(image)} />
    ) : (
      <Icon data-placeholder="" absoluteStrokeWidth />
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
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance);
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

/** Card thumbnail: the picture edge to edge, or the icon, framed in the project colour. */
export function ProjectCover({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance);
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

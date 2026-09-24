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

/** The user's picture always wins; the placeholder only fills an empty thumbnail. */
function useProjectThumbnail(appearance?: ProjectAppearance) {
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
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance);
  return (
    <span {...attributes} className={cn("homepage-project-badge", className)}>
      {content}
    </span>
  );
}

/** Card thumbnail: the picture edge to edge, or a neutral placeholder. */
export function ProjectCover({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectThumbnail(appearance);
  return (
    <span {...attributes} className={cn("homepage-project-cover", className)}>
      {content}
    </span>
  );
}

/** The project color, shown as a small accent next to the name. */
export function ProjectColorDot({
  appearance,
}: {
  appearance?: ProjectAppearance;
}) {
  return (
    <span
      aria-hidden="true"
      className="homepage-project-color"
      data-color={projectColor(appearance)}
    />
  );
}

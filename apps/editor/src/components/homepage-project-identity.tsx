import { useState } from "react";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  DEFAULT_PROJECT_APPEARANCE,
  PROJECT_COLOR_PRESETS,
  PROJECT_ICON_PRESETS,
} from "./homepage-project-appearance";

function useProjectIdentity(appearance?: ProjectAppearance) {
  const identity =
    normalizeProjectAppearance(appearance) ?? DEFAULT_PROJECT_APPEARANCE;
  const icon =
    PROJECT_ICON_PRESETS.find((preset) => preset.id === identity.icon) ??
    PROJECT_ICON_PRESETS[0];
  const color =
    PROJECT_COLOR_PRESETS.find((preset) => preset.id === identity.color)?.id ??
    DEFAULT_PROJECT_APPEARANCE.color;
  const [failedImage, setFailedImage] = useState<string | undefined>();
  const image =
    identity.image && identity.image !== failedImage
      ? identity.image
      : undefined;
  const Icon = icon.icon;
  return {
    attributes: {
      "aria-hidden": true,
      "data-color": color,
      "data-project-icon": icon.id,
      "data-has-image": Boolean(image),
    },
    content: image ? (
      <img src={image} alt="" onError={() => setFailedImage(image)} />
    ) : (
      <Icon />
    ),
  };
}

/** Compact flat chip for list rows and inline previews. */
export function ProjectIdentityBadge({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectIdentity(appearance);
  return (
    <span
      {...attributes}
      className={cn("homepage-project-badge", className)}
    >
      {content}
    </span>
  );
}

/** Card thumbnail: the picture edge to edge, or the icon on a tinted field. */
export function ProjectCover({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const { attributes, content } = useProjectIdentity(appearance);
  return (
    <span {...attributes} className={cn("homepage-project-cover", className)}>
      {content}
    </span>
  );
}

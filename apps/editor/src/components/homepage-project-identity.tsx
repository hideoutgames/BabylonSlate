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

export function ProjectIdentityBadge({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const identity =
    normalizeProjectAppearance(appearance) ?? DEFAULT_PROJECT_APPEARANCE;
  const icon =
    PROJECT_ICON_PRESETS.find((preset) => preset.id === identity.icon) ??
    PROJECT_ICON_PRESETS[0];
  const color =
    PROJECT_COLOR_PRESETS.find((preset) => preset.id === identity.color)?.id ??
    DEFAULT_PROJECT_APPEARANCE.color;
  const [failedImage, setFailedImage] = useState<string | undefined>();
  const Icon = icon.icon;
  return (
    <span
      aria-hidden="true"
      className={cn("homepage-project-badge", className)}
      data-color={color}
      data-project-icon={icon.id}
      data-has-image={Boolean(identity.image && identity.image !== failedImage)}
    >
      {identity.image && identity.image !== failedImage ? (
        <img
          src={identity.image}
          alt=""
          onError={() => setFailedImage(identity.image)}
        />
      ) : (
        <Icon />
      )}
    </span>
  );
}

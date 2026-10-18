import { useState } from "react";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@babylonslate/core";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  DEFAULT_PROJECT_APPEARANCE,
  projectIconPreset,
} from "./homepage-project-appearance";

/** The open project's icon in its colour, or its picture, as on its project card. */
export function ProjectIdentityMark({
  appearance,
  className,
}: {
  appearance?: ProjectAppearance;
  className?: string;
}) {
  const identity =
    normalizeProjectAppearance(appearance) ?? DEFAULT_PROJECT_APPEARANCE;
  const [failedImage, setFailedImage] = useState<string>();
  const image =
    identity.image && identity.cover !== "icon" && identity.image !== failedImage
      ? identity.image
      : undefined;
  const Icon = projectIconPreset(identity.icon).icon;
  return (
    <span
      className={cn("project-identity-mark", className)}
      data-project-color={identity.color}
      data-testid="project-identity-mark"
      aria-hidden="true"
    >
      {image ? (
        <img src={image} alt="" onError={() => setFailedImage(image)} />
      ) : (
        <Icon />
      )}
    </span>
  );
}

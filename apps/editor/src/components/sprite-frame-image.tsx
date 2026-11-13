import type { CSSProperties } from "react";
import type { TileRect } from "@haptic/assets";
import { cn } from "@haptic/ui/lib/utils";
import type { SpriteAnimationFrameView } from "./sprite-animation-sources";

/** The checkerboard drawn behind sprite frames, so transparent pixels show. */
export const CHECKERBOARD =
  "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%)";

function cropStyle(rect: TileRect, atlas: { width: number; height: number }): CSSProperties {
  return {
    left: `${(-rect.x / rect.width) * 100}%`,
    top: `${(-rect.y / rect.height) * 100}%`,
    width: `${(atlas.width / rect.width) * 100}%`,
    height: `${(atlas.height / rect.height) * 100}%`,
  };
}

/** The frame's image inside its box: a sheet cell is cropped from the sheet, other frames show the whole Texture. */
export function FrameImage({
  url,
  view,
  className,
  onError,
}: {
  url: string;
  view: SpriteAnimationFrameView | undefined;
  className?: string;
  onError?: () => void;
}) {
  if (view?.rect && view.atlas) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        <img
          src={url}
          alt=""
          draggable={false}
          onError={onError}
          className={cn("absolute max-w-none [image-rendering:pixelated]", className)}
          style={cropStyle(view.rect, view.atlas)}
        />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      onError={onError}
      className={cn("absolute inset-0 size-full object-contain [image-rendering:pixelated]", className)}
    />
  );
}


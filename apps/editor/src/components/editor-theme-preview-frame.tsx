import type { CSSProperties, ReactNode, Ref } from "react";
import { themeCssVariables, type ThemeColors } from "../lib/editor-themes";

/** The desktop size the miniature editor is laid out at before it is scaled down to fit its frame. */
export const THEME_PREVIEW_WIDTH = 1440;
export const THEME_PREVIEW_HEIGHT = 900;

/**
 * The theme preview's bordered box at its final size, in the theme's colors. Theme Settings shows it empty while the
 * miniature editor loads: that brings Dockview and the graph editor, which the Homepage leaves out of its first load.
 */
export function ThemePreviewFrame({
  colors,
  ref,
  children,
}: {
  colors: ThemeColors;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      inert
      data-testid="application-theme-preview"
      className="pointer-events-none relative w-full max-w-[640px] select-none overflow-hidden rounded-lg border border-border"
      style={{
        ...(themeCssVariables(colors) as CSSProperties),
        aspectRatio: `${THEME_PREVIEW_WIDTH} / ${THEME_PREVIEW_HEIGHT}`,
      }}
    >
      {children}
    </div>
  );
}

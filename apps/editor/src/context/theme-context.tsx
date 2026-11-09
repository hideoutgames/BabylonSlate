import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { setTouchUi } from "@haptic/editor-kit";
import { createStatusBarStyle } from "@haptic/vfs";
import { applyEditorTheme, resolveEditorTheme } from "../lib/editor-themes";
import { applyAccessibilityPresentation, followReduceMotion } from "../lib/accessibility-presentation";
import { useAppSettings, useCompactMode } from "./app-settings-context";

/**
 * Haptic is dark only. The boot script in index.html sets `html.dark` before
 * load; this keeps it set and gives the native status bar light glyphs. The
 * Application theme then overrides the dark tokens once settings load. It
 * also applies Compact Mode: `html.touch-ui` (the touch layout) while it is off,
 * and the root-level Accessibility settings (touch target, text size, Reduce
 * Motion, gesture timing, scrub snapping).
 */
export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const { settings, hydrated } = useAppSettings();
  const {
    editorTheme,
    customEditorThemes,
    touchTargetScale,
    textSizePercent,
    holdTimeMs,
    doubleTapTimeMs,
    numberSnapStrength,
    reduceMotion,
  } = settings;
  const compact = useCompactMode();
  // Accessibility waits for the saved settings, so the boot script's Reduce
  // Motion and the default sizes hold until then instead of flashing.
  useLayoutEffect(() => {
    if (!hydrated) return;
    applyAccessibilityPresentation({ touchTargetScale, textSizePercent, holdTimeMs, doubleTapTimeMs, numberSnapStrength });
  }, [hydrated, touchTargetScale, textSizePercent, holdTimeMs, doubleTapTimeMs, numberSnapStrength]);
  useLayoutEffect(() => (hydrated ? followReduceMotion(reduceMotion) : undefined), [hydrated, reduceMotion]);
  useEffect(() => {
    document.documentElement.classList.add("dark");
    void createStatusBarStyle()
      .setStyle("light")
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    applyEditorTheme(resolveEditorTheme(editorTheme, customEditorThemes));
  }, [editorTheme, customEditorThemes]);
  useLayoutEffect(() => {
    setTouchUi(!compact);
  }, [compact]);
  return children;
}

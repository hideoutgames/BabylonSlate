import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { setTouchUi } from "@babylonslate/editor-kit";
import { createStatusBarStyle } from "@babylonslate/vfs";
import { applyEditorTheme, resolveEditorTheme } from "../lib/editor-themes";
import { useAppSettings, useCompactMode } from "./app-settings-context";

/**
 * Haptic is dark only. The boot script in index.html sets `html.dark` before
 * load; this keeps it set and gives the native status bar light glyphs. The
 * Application theme then overrides the dark tokens once settings load. It
 * also applies Compact Mode: `html.touch-ui` (the touch layout) while it is off.
 */
export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings();
  const { editorTheme, customEditorThemes } = settings;
  const compact = useCompactMode();
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

import { useEffect, type ReactNode } from "react";
import { createStatusBarStyle } from "@haptic/vfs";
import { applyEditorTheme, resolveEditorTheme } from "../lib/editor-themes";
import { useAppSettings } from "./app-settings-context";

/**
 * Haptic is dark only. The boot script in index.html sets `html.dark` before
 * load; this keeps it set and gives the native status bar light glyphs. The
 * Application theme then overrides the dark tokens once settings load.
 */
export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings();
  const { editorTheme, customEditorThemes } = settings;
  useEffect(() => {
    document.documentElement.classList.add("dark");
    void createStatusBarStyle()
      .setStyle("light")
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    applyEditorTheme(resolveEditorTheme(editorTheme, customEditorThemes));
  }, [editorTheme, customEditorThemes]);
  return children;
}

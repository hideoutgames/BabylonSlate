import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { setTouchUi } from "@babylonslate/editor-kit";
import { createStatusBarStyle } from "@babylonslate/vfs";
import { useCompactMode } from "./app-settings-context";

/**
 * Haptic is dark only. The boot script in index.html sets `html.dark` before
 * load; this keeps it set and gives the native status bar light glyphs. It
 * also applies Compact Mode: `html.touch-ui` (the touch layout) while it is off.
 */
export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const compact = useCompactMode();
  useEffect(() => {
    document.documentElement.classList.add("dark");
    void createStatusBarStyle()
      .setStyle("light")
      .catch(() => undefined);
  }, []);
  useLayoutEffect(() => {
    setTouchUi(!compact);
  }, [compact]);
  return children;
}

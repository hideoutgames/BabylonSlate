import { useEffect, type ReactNode } from "react";
import { createStatusBarStyle } from "@babylonslate/vfs";

/**
 * Haptic is dark only. The boot script in index.html sets `html.dark` before
 * load; this keeps it set and gives the native status bar light glyphs.
 */
export function EditorThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    void createStatusBarStyle()
      .setStyle("light")
      .catch(() => undefined);
  }, []);
  return children;
}

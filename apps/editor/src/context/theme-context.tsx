import { createContext, useContext, useEffect, type ReactNode } from "react";
import { applyDocumentTheme, type ResolvedTheme } from "../lib/resolved-theme";

/** Haptic is dark only. */
const EDITOR_THEME: ResolvedTheme = "dark";

const ThemeContext = createContext<ResolvedTheme | null>(null);

export function EditorThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyDocumentTheme(EDITOR_THEME);
  }, []);

  return (
    <ThemeContext.Provider value={EDITOR_THEME}>{children}</ThemeContext.Provider>
  );
}

export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext) ?? EDITOR_THEME;
}

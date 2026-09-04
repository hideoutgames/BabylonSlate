import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyDocumentTheme,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
  ENGINE_SETTINGS_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "../lib/resolved-theme";
import { useAppSettings } from "./app-settings-context";

const ThemeContext = createContext<ResolvedTheme | null>(null);

function storedPreference(): ThemePreference {
  try {
    return readStoredThemePreference(
      localStorage.getItem(ENGINE_SETTINGS_STORAGE_KEY),
    );
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings();
  const preference = settings.appearance.theme;
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (preference !== "system") return;
    setPrefersDark(systemPrefersDark());
    return subscribeSystemTheme(setPrefersDark);
  }, [preference]);

  const resolved = useMemo(
    () => resolveTheme(preference, prefersDark),
    [preference, prefersDark],
  );

  useEffect(() => {
    applyDocumentTheme(resolved);
  }, [resolved]);

  return (
    <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>
  );
}

export function useResolvedTheme(): ResolvedTheme {
  const scheme = useContext(ThemeContext);
  if (scheme) return scheme;
  return resolveTheme(storedPreference(), systemPrefersDark());
}

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createAppSettingsStore } from "@babylonslate/vfs";
import {
  applyDocumentTheme,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
  ENGINE_SETTINGS_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "../lib/resolved-theme";
import { ENGINE_SETTINGS_CHANGED_EVENT } from "../lib/viewport-render-gate";

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
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function EditorThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    const store = createAppSettingsStore();
    void store.load().then((settings) => {
      setPreference(settings.appearance.theme);
    });
  }, []);

  useEffect(() => {
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ theme?: ThemePreference }>).detail;
      if (detail?.theme) setPreference(detail.theme);
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    return () =>
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
  }, []);

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

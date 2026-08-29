import {
  createStatusBarStyle,
  ENGINE_SETTINGS_STORAGE_KEY,
  type StatusBarGlyphStyle,
} from "@babylonslate/vfs";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export { ENGINE_SETTINGS_STORAGE_KEY };

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}

export function readStoredThemePreference(raw: string | null): ThemePreference {
  if (!raw) return "system";
  try {
    const parsed = JSON.parse(raw) as {
      appearance?: { theme?: unknown };
    };
    const theme = parsed.appearance?.theme;
    if (theme === "light" || theme === "dark" || theme === "system") {
      return theme;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

export function applyDocumentTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  void createStatusBarStyle().setStyle(statusBarStyleForTheme(resolved));
}

export function statusBarStyleForTheme(
  resolved: ResolvedTheme,
): StatusBarGlyphStyle {
  return resolved === "dark" ? "light" : "dark";
}

export function documentColorScheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function subscribeSystemTheme(
  onChange: (prefersDark: boolean) => void,
): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event: MediaQueryListEvent) => {
    onChange(event.matches);
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

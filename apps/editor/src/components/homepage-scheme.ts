import { useCallback } from "react";
import { useAppSettings } from "../context/app-settings-context";
import { useResolvedTheme } from "../context/theme-context";
import type { ResolvedTheme } from "../lib/resolved-theme";

export function useHomepageScheme() {
  const scheme = useResolvedTheme();
  const { updateSettings } = useAppSettings();
  const setScheme = useCallback(
    (value: ResolvedTheme) =>
      updateSettings((settings) => {
        settings.appearance.theme = value;
      }),
    [updateSettings],
  );
  return [scheme, setScheme] as const;
}

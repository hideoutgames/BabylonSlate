import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEngineSettings } from "@babylonslate/vfs";
import { ENGINE_SETTINGS_STORAGE_KEY } from "../lib/resolved-theme";
import { dispatchEngineSettingsChanged } from "../lib/viewport-render-gate";
import { EditorThemeProvider, useResolvedTheme } from "./theme-context";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

function SchemeProbe() {
  const scheme = useResolvedTheme();
  return <span data-testid="resolved-scheme">{scheme}</span>;
}

describe("EditorThemeProvider", () => {
  it("applies a stored light preference to html", async () => {
    const settings = defaultEngineSettings();
    settings.appearance.theme = "light";
    localStorage.setItem(ENGINE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    document.documentElement.classList.add("dark");

    render(
      <EditorThemeProvider>
        <SchemeProbe />
      </EditorThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
    expect(document.querySelector("[data-testid=resolved-scheme]")?.textContent).toBe(
      "light",
    );
  });

  it("switches html.dark when engine settings dispatch a theme", async () => {
    render(
      <EditorThemeProvider>
        <SchemeProbe />
      </EditorThemeProvider>,
    );

    dispatchEngineSettingsChanged({
      viewportFrameCap: 60,
      theme: "dark",
    });
    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    dispatchEngineSettingsChanged({
      viewportFrameCap: 60,
      theme: "light",
    });
    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });
});

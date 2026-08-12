import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import {
  applyDocumentTheme,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
} from "./resolved-theme";

describe("resolveTheme", () => {
  it("returns light or dark when the preference is explicit", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system preference when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("readStoredThemePreference", () => {
  it("reads appearance.theme from engine settings JSON", () => {
    expect(
      readStoredThemePreference(
        JSON.stringify({ appearance: { theme: "light" } }),
      ),
    ).toBe("light");
    expect(
      readStoredThemePreference(
        JSON.stringify({ appearance: { theme: "dark" } }),
      ),
    ).toBe("dark");
  });

  it("defaults to system when missing or invalid", () => {
    expect(readStoredThemePreference(null)).toBe("system");
    expect(readStoredThemePreference("{not-json")).toBe("system");
    expect(readStoredThemePreference("{}")).toBe("system");
  });
});

describe("applyDocumentTheme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("toggles the html.dark class", () => {
    applyDocumentTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyDocumentTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("subscribeSystemTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies when prefers-color-scheme changes", () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches: true,
      addEventListener(
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) {
        listeners.add(listener);
      },
      removeEventListener(
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) {
        listeners.delete(listener);
      },
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media),
    );

    const seen: boolean[] = [];
    const unsubscribe = subscribeSystemTheme((prefersDark) => {
      seen.push(prefersDark);
    });
    for (const listener of listeners) {
      listener({ matches: false } as MediaQueryListEvent);
    }
    expect(seen).toEqual([false]);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});

describe("theme boot script", () => {
  it("reads engine settings from localStorage before first paint", () => {
    expect(indexHtml).toContain('localStorage.getItem("babylonslate:engine-settings")');
    expect(indexHtml).toContain("prefers-color-scheme: dark");
    expect(indexHtml).not.toMatch(/<html[^>]*class="dark"/);
  });
});

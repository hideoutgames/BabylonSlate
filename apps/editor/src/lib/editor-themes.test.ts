import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultEngineSettings } from "@haptic/vfs";
import {
  BUILT_IN_EDITOR_THEMES,
  DEFAULT_EDITOR_THEME_ID,
  editorThemeStylesheet,
  parseEditorThemeFile,
  resolveEditorTheme,
  serializeEditorTheme,
  setActiveThemeColor,
  THEME_COLOR_GROUPS,
  THEME_COLOR_KEYS,
} from "./editor-themes";

const defaultTheme = BUILT_IN_EDITOR_THEMES[0]!;

function oklchToHex(text: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(text);
  if (!match) return undefined;
  const [lightness, chroma, hue] = match.slice(1).map(Number) as [number, number, number];
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((value) => {
      const clamped = Math.max(0, Math.min(1, value));
      const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

describe("editor themes", () => {
  it("keeps Default in sync with the dark tokens it stands for", () => {
    const css = readFileSync(new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url), "utf8");
    const dark = css.slice(css.indexOf("\n.dark {"));
    const tokens = Object.fromEntries(
      [...dark.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]),
    );
    for (const key of THEME_COLOR_KEYS) {
      expect(tokens[key], key).toBeDefined();
      expect(oklchToHex(tokens[key]!), key).toBe(defaultTheme.colors[key]);
    }
  });

  it("lists every theme color in exactly one Style group", () => {
    const grouped = THEME_COLOR_GROUPS.flatMap((group) => group.colors.map((color) => color.key));
    expect([...grouped].sort()).toEqual([...THEME_COLOR_KEYS].sort());
  });

  it("forks a built-in theme on the first edit and edits the fork afterwards", () => {
    const settings = defaultEngineSettings();
    expect(setActiveThemeColor(settings, "background", "#102030")).toEqual({ forkedName: "Default Copy" });
    expect(setActiveThemeColor(settings, "card", "#203040")).toEqual({});

    expect(settings.customEditorThemes).toHaveLength(1);
    const [fork] = settings.customEditorThemes;
    expect(settings.editorTheme).toBe(fork!.id);
    expect(fork!.colors).toEqual({ background: "#102030", card: "#203040" });
    expect(resolveEditorTheme(DEFAULT_EDITOR_THEME_ID, settings.customEditorThemes).colors.background).toBe(
      defaultTheme.colors.background,
    );

    settings.editorTheme = DEFAULT_EDITOR_THEME_ID;
    expect(setActiveThemeColor(settings, "background", "#000000")).toEqual({ forkedName: "Default Copy 2" });
  });

  it("falls back to Default when the selected theme is gone", () => {
    expect(resolveEditorTheme("custom-missing", []).id).toBe(DEFAULT_EDITOR_THEME_ID);
  });

  it("overrides only changed colors, including nested dark scopes", () => {
    expect(editorThemeStylesheet(defaultTheme.colors)).toBe("");
    const css = editorThemeStylesheet({ ...defaultTheme.colors, sidebar: "#123456" });
    expect(css).toContain(":root .dark");
    expect(css).toContain("--sidebar: #123456;");
    expect(css).not.toContain("--background");
  });

  it("round-trips an exported theme", () => {
    const colors = { ...defaultTheme.colors, accent: "#abcdef" };
    const parsed = parseEditorThemeFile(serializeEditorTheme({ id: "custom-a", name: "Night", builtIn: false, colors }));
    expect(parsed).toEqual({ ok: true, name: "Night", colors });
  });

  it("imports partial themes over Default and rejects other files", () => {
    const parsed = parseEditorThemeFile(
      JSON.stringify({ format: "haptic-editor-theme", version: 1, name: "Bits", colors: { card: "#ABCDEF", nope: "#000000", border: "red" } }),
    );
    expect(parsed).toEqual({ ok: true, name: "Bits", colors: { ...defaultTheme.colors, card: "#abcdef" } });
    expect(parseEditorThemeFile("{")).toEqual({ ok: false, error: "The file is not valid JSON." });
    expect(parseEditorThemeFile(JSON.stringify({ name: "x", colors: {} }))).toMatchObject({ ok: false });
    expect(
      parseEditorThemeFile(JSON.stringify({ format: "haptic-editor-theme", version: 2, colors: {} })),
    ).toEqual({ ok: false, error: "The theme was made by a newer version of Haptic." });
  });
});

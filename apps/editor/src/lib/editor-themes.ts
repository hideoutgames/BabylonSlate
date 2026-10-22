import type { CustomEditorTheme, EngineSettings } from "@babylonslate/vfs";

/**
 * Editor themes override the dark tokens in `packages/ui/src/styles/tokens.css`.
 * Built-in themes are read-only; editing one forks a custom theme that is
 * stored in Application settings. Colors are `#rrggbb` keyed by token name.
 */

export const DEFAULT_EDITOR_THEME_ID = "default";

export const EDITOR_THEME_FILE_FORMAT = "haptic-editor-theme";
const EDITOR_THEME_FILE_VERSION = 1;

/** The Default theme's `.dark` token values as sRGB hex; a test keeps them in sync. */
const DEFAULT_COLORS = {
  background: "#0d0c0a",
  sidebar: "#141211",
  card: "#1b1917",
  "panel-header": "#12100f",
  popover: "#1d1b19",
  control: "#0a0907",
  muted: "#181715",
  secondary: "#2f2d2b",
  accent: "#2a2725",
  foreground: "#f6f5f4",
  "muted-foreground": "#a3a19d",
  primary: "#f6f5f4",
  "primary-foreground": "#0c0b09",
  border: "#2b2a28",
  input: "#3c3a38",
  ring: "#ffaf01",
  selection: "#ff8000",
  "brand-red": "#fe4100",
  "brand-amber": "#ffaf01",
  "axis-z": "#398ad6",
  destructive: "#ff6467",
  "destructive-foreground": "#181a1c",
  success: "#269e5f",
  warning: "#edb345",
  play: "#1a7244",
  "play-foreground": "#fcfcfa",
  stop: "#b63132",
  "stop-foreground": "#fcfcfa",
  "trace-selected": "#ff8c1e",
  "trace-script": "#699ef5",
  "trace-physics": "#26bdae",
  "graph-canvas": "#0b0a08",
  "graph-node": "#1c1a19",
  "node-title-foreground": "#f4f9ff",
  "graph-state-selected": "#f7bc50",
  "graph-state-entry": "#66c189",
  "node-event": "#a5292b",
  "node-call-parent": "#723e14",
  "node-function": "#004f8b",
  "node-pure": "#005f2e",
  "node-flow": "#404952",
  "node-variable": "#006374",
  "node-variable-set": "#89202b",
  "node-latent": "#9b6500",
  "node-debug": "#53452f",
  "node-bt-root": "#7a3430",
  "node-bt-composite": "#2e4a67",
  "node-bt-task": "#005a7a",
  "node-bt-decorator": "#805400",
  "node-bt-service": "#006752",
  "pin-exec": "#eeeeee",
  "pin-bool": "#ff4c4d",
  "pin-int": "#3aced6",
  "pin-float": "#88d656",
  "pin-string": "#ed66e5",
  "pin-vector": "#f6c835",
  "pin-rotator": "#a883ff",
  "pin-quat": "#c690ec",
  "pin-transform": "#fc8c45",
  "pin-color": "#f8a4a3",
  "pin-object": "#3b9cf6",
  "pin-actor": "#009edb",
  "pin-class": "#7d8df9",
  "pin-struct": "#7d8df9",
  "pin-enum": "#00b789",
  "pin-tag": "#4475f6",
  "pin-wildcard": "#9ba6b1",
  "pin-delegate": "#f04c5a",
  "pin-particle": "#6cfcd0",
  "asset-scene": "#c4a200",
  "asset-graph": "#00b5b7",
  "asset-texture": "#d974c5",
  "asset-material": "#68cb6e",
  "asset-model": "#f47f46",
  "asset-audio": "#8ca507",
  "asset-font": "#00b1e8",
  "asset-animation": "#49a9ff",
  "asset-class": "#7d8df9",
  "asset-script-type": "#00b789",
  "asset-component": "#b07be6",
  "asset-folder": "#ea9602",
} as const;

export type ThemeColorKey = keyof typeof DEFAULT_COLORS;
export type ThemeColors = Record<ThemeColorKey, string>;

export const THEME_COLOR_KEYS = Object.keys(DEFAULT_COLORS) as ThemeColorKey[];

export interface ThemeColorGroup {
  id: string;
  label: string;
  colors: { key: ThemeColorKey; label: string }[];
}

const color = (key: ThemeColorKey, label: string) => ({ key, label });

/** Style menu layout: every theme color, grouped as the editor uses them. */
export const THEME_COLOR_GROUPS: ThemeColorGroup[] = [
  {
    id: "surfaces",
    label: "Surfaces",
    colors: [
      color("background", "Background"),
      color("sidebar", "Sidebar"),
      color("card", "Card"),
      color("panel-header", "Panel Header"),
      color("popover", "Popover"),
      color("control", "Control"),
      color("muted", "Muted"),
      color("secondary", "Secondary"),
      color("accent", "Hover"),
    ],
  },
  {
    id: "text",
    label: "Text And Lines",
    colors: [
      color("foreground", "Text"),
      color("muted-foreground", "Muted Text"),
      color("primary", "Primary"),
      color("primary-foreground", "Primary Text"),
      color("border", "Border"),
      color("input", "Input Border"),
      color("ring", "Focus Ring"),
    ],
  },
  {
    id: "accents",
    label: "Accents",
    colors: [
      color("selection", "Selection"),
      color("brand-red", "Brand Red"),
      color("brand-amber", "Brand Amber"),
      color("axis-z", "Z Axis"),
    ],
  },
  {
    id: "status",
    label: "Status",
    colors: [
      color("destructive", "Destructive"),
      color("destructive-foreground", "Destructive Text"),
      color("success", "Success"),
      color("warning", "Warning"),
      color("play", "Play"),
      color("play-foreground", "Play Text"),
      color("stop", "Stop"),
      color("stop-foreground", "Stop Text"),
      color("trace-selected", "Trace Selected"),
      color("trace-script", "Trace Script"),
      color("trace-physics", "Trace Physics"),
    ],
  },
  {
    id: "graph",
    label: "Graph",
    colors: [
      color("graph-canvas", "Canvas"),
      color("graph-node", "Node"),
      color("node-title-foreground", "Node Title Text"),
      color("graph-state-selected", "Selected State"),
      color("graph-state-entry", "Entry State"),
      color("node-event", "Event"),
      color("node-call-parent", "Call Parent"),
      color("node-function", "Function"),
      color("node-pure", "Pure"),
      color("node-flow", "Flow"),
      color("node-variable", "Variable"),
      color("node-variable-set", "Variable Set"),
      color("node-latent", "Latent"),
      color("node-debug", "Debug"),
      color("node-bt-root", "BT Root"),
      color("node-bt-composite", "BT Composite"),
      color("node-bt-task", "BT Task"),
      color("node-bt-decorator", "BT Decorator"),
      color("node-bt-service", "BT Service"),
    ],
  },
  {
    id: "pins",
    label: "Pins",
    colors: [
      color("pin-exec", "Exec"),
      color("pin-bool", "Boolean"),
      color("pin-int", "Integer"),
      color("pin-float", "Float"),
      color("pin-string", "String"),
      color("pin-vector", "Vector"),
      color("pin-rotator", "Rotator"),
      color("pin-quat", "Quaternion"),
      color("pin-transform", "Transform"),
      color("pin-color", "Color"),
      color("pin-object", "Object"),
      color("pin-actor", "Actor"),
      color("pin-class", "Class"),
      color("pin-struct", "Struct"),
      color("pin-enum", "Enum"),
      color("pin-tag", "Tag"),
      color("pin-wildcard", "Wildcard"),
      color("pin-delegate", "Delegate"),
      color("pin-particle", "Particle"),
    ],
  },
  {
    id: "assets",
    label: "Asset Types",
    colors: [
      color("asset-scene", "Scene"),
      color("asset-graph", "Graph"),
      color("asset-texture", "Texture"),
      color("asset-material", "Material"),
      color("asset-model", "Model"),
      color("asset-audio", "Audio"),
      color("asset-font", "Font"),
      color("asset-animation", "Animation"),
      color("asset-class", "Class"),
      color("asset-script-type", "Script Type"),
      color("asset-component", "Component"),
      color("asset-folder", "Folder"),
    ],
  },
];

export interface EditorTheme {
  id: string;
  name: string;
  /** Built-in themes are never edited; editing one forks a custom theme. */
  builtIn: boolean;
  colors: ThemeColors;
}

export const BUILT_IN_EDITOR_THEMES: readonly EditorTheme[] = [
  {
    id: DEFAULT_EDITOR_THEME_ID,
    name: "Default",
    builtIn: true,
    colors: { ...DEFAULT_COLORS },
  },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Known keys with valid colors; anything missing falls back to Default. */
export function completeThemeColors(colors: Record<string, unknown>): ThemeColors {
  const complete = { ...DEFAULT_COLORS } as ThemeColors;
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key];
    if (typeof value === "string" && HEX_COLOR.test(value)) complete[key] = value.toLowerCase();
  }
  return complete;
}

export function customToEditorTheme(theme: CustomEditorTheme): EditorTheme {
  return { id: theme.id, name: theme.name, builtIn: false, colors: completeThemeColors(theme.colors) };
}

/** Built-ins first, then custom themes in creation order. */
export function listEditorThemes(customThemes: readonly CustomEditorTheme[]): EditorTheme[] {
  return [...BUILT_IN_EDITOR_THEMES, ...customThemes.map(customToEditorTheme)];
}

/** The selected theme, or Default when the id no longer exists. */
export function resolveEditorTheme(
  themeId: string,
  customThemes: readonly CustomEditorTheme[],
): EditorTheme {
  const themes = listEditorThemes(customThemes);
  return themes.find((theme) => theme.id === themeId) ?? themes[0]!;
}

/** `name`, or `name 2`, `name 3`, ... so theme names stay distinct. */
export function uniqueThemeName(name: string, taken: Iterable<string>): string {
  const base = name.trim() || "Custom Theme";
  const used = new Set([...taken].map((entry) => entry.toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function newCustomThemeId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `custom-${random}`;
}

/** Only colors that differ from Default are stored and applied. */
export function themeColorOverrides(colors: ThemeColors): Partial<ThemeColors> {
  const overrides: Partial<ThemeColors> = {};
  for (const key of THEME_COLOR_KEYS) {
    if (colors[key] !== DEFAULT_COLORS[key]) overrides[key] = colors[key];
  }
  return overrides;
}

/** A new custom theme copied from `base`, named after it. */
export function forkEditorTheme(
  base: EditorTheme,
  takenNames: Iterable<string>,
  colors: ThemeColors = base.colors,
): CustomEditorTheme {
  return {
    id: newCustomThemeId(),
    name: uniqueThemeName(base.builtIn ? `${base.name} Copy` : base.name, takenNames),
    colors: themeColorOverrides(colors),
  };
}

/**
 * Sets one color on the settings' active theme. A built-in theme is never
 * changed: the edit forks a custom theme and selects it. Deciding inside the
 * mutation keeps a burst of picker changes from forking more than once.
 */
export function setActiveThemeColor(
  settings: EngineSettings,
  key: ThemeColorKey,
  value: string,
): { forkedName?: string } {
  const active = resolveEditorTheme(settings.editorTheme, settings.customEditorThemes);
  const colors = { ...active.colors, [key]: value };
  if (active.builtIn) {
    const fork = forkEditorTheme(
      active,
      listEditorThemes(settings.customEditorThemes).map((theme) => theme.name),
      colors,
    );
    settings.customEditorThemes.push(fork);
    settings.editorTheme = fork.id;
    return { forkedName: fork.name };
  }
  const stored = settings.customEditorThemes.find((theme) => theme.id === active.id);
  if (stored) stored.colors = themeColorOverrides(colors);
  return {};
}

/** CSS custom properties for a theme, for scoping a preview to it. */
export function themeCssVariables(colors: ThemeColors): Record<string, string> {
  return Object.fromEntries(THEME_COLOR_KEYS.map((key) => [`--${key}`, colors[key]]));
}

/**
 * Stylesheet text that applies a theme over the `.dark` tokens. `:root .dark`
 * also reaches nested `.dark` scopes such as graph canvases, which redeclare
 * the tokens; the extra `:root` outranks `tokens.css`.
 */
export function editorThemeStylesheet(colors: ThemeColors): string {
  const overrides = themeColorOverrides(colors);
  const declarations = Object.entries(overrides).map(([key, value]) => `  --${key}: ${value};`);
  if (!declarations.length) return "";
  return `:root:root, :root .dark {\n${declarations.join("\n")}\n}\n`;
}

const THEME_STYLE_ELEMENT_ID = "haptic-editor-theme";

/** Applies `theme` to the document; Default removes every override. */
export function applyEditorTheme(theme: EditorTheme, doc: Document = document): void {
  const css = editorThemeStylesheet(theme.colors);
  let element = doc.getElementById(THEME_STYLE_ELEMENT_ID);
  if (!css) {
    element?.remove();
    return;
  }
  if (!element) {
    element = doc.createElement("style");
    element.id = THEME_STYLE_ELEMENT_ID;
    doc.head.appendChild(element);
  }
  element.textContent = css;
}

/** Portable theme file text. */
export function serializeEditorTheme(theme: EditorTheme): string {
  return `${JSON.stringify(
    {
      format: EDITOR_THEME_FILE_FORMAT,
      version: EDITOR_THEME_FILE_VERSION,
      name: theme.name,
      colors: theme.colors,
    },
    null,
    2,
  )}\n`;
}

export function editorThemeFileName(theme: EditorTheme): string {
  const stem = theme.name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${stem || "theme"}.haptic-theme.json`;
}

export type ParsedThemeFile =
  | { ok: true; name: string; colors: ThemeColors }
  | { ok: false; error: string };

/** Reads a theme file; unknown colors are ignored and missing ones use Default. */
export function parseEditorThemeFile(text: string): ParsedThemeFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "The file is not a Haptic theme." };
  }
  const record = data as Record<string, unknown>;
  if (record.format !== EDITOR_THEME_FILE_FORMAT) {
    return { ok: false, error: "The file is not a Haptic theme." };
  }
  if (typeof record.version !== "number" || record.version > EDITOR_THEME_FILE_VERSION) {
    return { ok: false, error: "The theme was made by a newer version of Haptic." };
  }
  const colors = record.colors;
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) {
    return { ok: false, error: "The theme has no colors." };
  }
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Imported Theme";
  return { ok: true, name, colors: completeThemeColors(colors as Record<string, unknown>) };
}

import type { CustomEditorTheme, EngineSettings } from "@haptic/vfs";

/**
 * Editor themes override the dark tokens in `packages/ui/src/styles/tokens.css`.
 * Built-in themes are read-only; editing one forks a custom theme that is
 * stored in Application settings. Colors are `#rrggbb` keyed by token name.
 */

export const DEFAULT_EDITOR_THEME_ID = "default";

export const EDITOR_THEME_FILE_FORMAT = "haptic-editor-theme";
const EDITOR_THEME_FILE_VERSION = 1;

/** Haptic Dark's `.dark` token values as sRGB hex; a test keeps them in sync. */
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

/** Mixes two `#rrggbb` colors; `amount` 0 is `from`, 1 is `to`. */
function mix(from: string, to: string, amount: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Relative luminance of a `#rrggbb` color, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [0, 1, 2].map((index) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Haptic White: light chrome, light graph canvas, dark node titles kept. */
const HAPTIC_WHITE_COLORS: ThemeColors = {
  ...DEFAULT_COLORS,
  background: "#c2c2c2",
  sidebar: "#ebebeb",
  card: "#f4f4f4",
  "panel-header": "#e3e3e3",
  popover: "#ffffff",
  control: "#ffffff",
  muted: "#e3e3e3",
  secondary: "#d6d6d6",
  accent: "#dcdcdc",
  foreground: "#1f1f1f",
  "muted-foreground": "#666666",
  primary: "#1f1f1f",
  "primary-foreground": "#ffffff",
  border: "#d1d1d1",
  input: "#bdbdbd",
  ring: "#e09a00",
  selection: "#ff8000",
  "axis-z": "#2f78c4",
  destructive: "#d93036",
  "destructive-foreground": "#ffffff",
  success: "#1d8650",
  warning: "#b7791f",
  "trace-selected": "#e8740c",
  "trace-script": "#3f7fe0",
  "trace-physics": "#159a8c",
  "graph-canvas": "#dedede",
  "graph-node": "#fafafa",
  "graph-state-selected": "#d99a1e",
  "graph-state-entry": "#2f9e5c",
  "pin-exec": "#3a3a3a",
  ...Object.fromEntries(
    THEME_COLOR_KEYS.filter((key) => (key.startsWith("pin-") && key !== "pin-exec") || key.startsWith("asset-")).map(
      (key) => [key, mix(DEFAULT_COLORS[key], "#000000", 0.18)],
    ),
  ),
};

/** The few colors a ported theme supplies; everything else is derived from them. */
interface ThemePalette {
  /** Gaps between panels, the darkest (or, on light themes, the dimmest) surface. */
  background: string;
  sidebar: string;
  card: string;
  popover: string;
  control: string;
  muted: string;
  secondary: string;
  hover: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  input: string;
  ring: string;
  selection: string;
  graphCanvas: string;
  red: string;
  orange: string;
  yellow: string;
  green: string;
  cyan: string;
  blue: string;
  purple: string;
  pink: string;
}

/** Node title bars stay dark enough for light title text on every theme. */
const nodeTitle = (hue: string, depth = 0.4) => mix(hue, "#000000", depth);

function paletteColors(palette: ThemePalette): ThemeColors {
  const { red, orange, yellow, green, cyan, blue, purple, pink } = palette;
  const light = luminance(palette.card) > 0.5;
  const pin = (hue: string) => (light ? mix(hue, "#000000", 0.12) : hue);
  return {
    ...DEFAULT_COLORS,
    background: palette.background,
    sidebar: palette.sidebar,
    card: palette.card,
    "panel-header": palette.sidebar,
    popover: palette.popover,
    control: palette.control,
    muted: palette.muted,
    secondary: palette.secondary,
    accent: palette.hover,
    foreground: palette.foreground,
    "muted-foreground": palette.mutedForeground,
    primary: palette.foreground,
    "primary-foreground": palette.card,
    border: palette.border,
    input: palette.input,
    ring: palette.ring,
    selection: palette.selection,
    "axis-z": blue,
    destructive: red,
    "destructive-foreground": light ? "#ffffff" : palette.background,
    success: green,
    warning: yellow,
    play: nodeTitle(green, 0.45),
    "play-foreground": "#ffffff",
    stop: nodeTitle(red, 0.3),
    "stop-foreground": "#ffffff",
    "trace-selected": orange,
    "trace-script": blue,
    "trace-physics": cyan,
    "graph-canvas": palette.graphCanvas,
    "graph-node": palette.card,
    "node-title-foreground": "#ffffff",
    "graph-state-selected": yellow,
    "graph-state-entry": green,
    "node-event": nodeTitle(red),
    "node-call-parent": nodeTitle(orange, 0.5),
    "node-function": nodeTitle(blue, 0.5),
    "node-pure": nodeTitle(green, 0.55),
    "node-flow": nodeTitle(palette.mutedForeground, 0.5),
    "node-variable": nodeTitle(cyan, 0.55),
    "node-variable-set": nodeTitle(mix(red, pink, 0.4), 0.45),
    "node-latent": nodeTitle(yellow, 0.5),
    "node-debug": nodeTitle(mix(orange, palette.mutedForeground, 0.5), 0.55),
    "node-bt-root": nodeTitle(red, 0.5),
    "node-bt-composite": nodeTitle(mix(blue, palette.mutedForeground, 0.4), 0.5),
    "node-bt-task": nodeTitle(cyan, 0.5),
    "node-bt-decorator": nodeTitle(yellow, 0.55),
    "node-bt-service": nodeTitle(mix(green, cyan, 0.5), 0.55),
    "pin-exec": palette.foreground,
    "pin-bool": pin(red),
    "pin-int": pin(cyan),
    "pin-float": pin(green),
    "pin-string": pin(pink),
    "pin-vector": pin(yellow),
    "pin-rotator": pin(purple),
    "pin-quat": pin(mix(purple, pink, 0.5)),
    "pin-transform": pin(orange),
    "pin-color": pin(mix(red, "#ffffff", 0.4)),
    "pin-object": pin(blue),
    "pin-actor": pin(mix(blue, cyan, 0.5)),
    "pin-class": pin(mix(blue, purple, 0.5)),
    "pin-struct": pin(mix(blue, purple, 0.5)),
    "pin-enum": pin(mix(green, cyan, 0.5)),
    "pin-tag": pin(mix(blue, purple, 0.25)),
    "pin-wildcard": palette.mutedForeground,
    "pin-delegate": pin(mix(red, pink, 0.5)),
    "pin-particle": pin(mix(cyan, green, 0.4)),
    "asset-scene": pin(yellow),
    "asset-graph": pin(cyan),
    "asset-texture": pin(pink),
    "asset-material": pin(green),
    "asset-model": pin(orange),
    "asset-audio": pin(mix(green, yellow, 0.5)),
    "asset-font": pin(mix(cyan, blue, 0.5)),
    "asset-animation": pin(blue),
    "asset-class": pin(mix(blue, purple, 0.5)),
    "asset-script-type": pin(mix(green, cyan, 0.5)),
    "asset-component": pin(purple),
    "asset-folder": pin(mix(orange, yellow, 0.5)),
  };
}

/** Ports of popular public color schemes, named after them (each is MIT licensed). */
const PORTED_THEMES: { id: string; name: string; palette: ThemePalette }[] = [
  {
    // https://draculatheme.com
    id: "dracula",
    name: "Dracula",
    palette: {
      background: "#191a21",
      sidebar: "#21222c",
      card: "#282a36",
      popover: "#343746",
      control: "#1e1f29",
      muted: "#2c2e3b",
      secondary: "#44475a",
      hover: "#3a3c4e",
      foreground: "#f8f8f2",
      mutedForeground: "#a6accd",
      border: "#343746",
      input: "#44475a",
      ring: "#bd93f9",
      selection: "#ff79c6",
      graphCanvas: "#1e1f29",
      red: "#ff5555",
      orange: "#ffb86c",
      yellow: "#f1fa8c",
      green: "#50fa7b",
      cyan: "#8be9fd",
      blue: "#6c9cf9",
      purple: "#bd93f9",
      pink: "#ff79c6",
    },
  },
  {
    // https://www.nordtheme.com
    id: "nord",
    name: "Nord",
    palette: {
      background: "#20242c",
      sidebar: "#2b303b",
      card: "#2e3440",
      popover: "#3b4252",
      control: "#262a33",
      muted: "#353b48",
      secondary: "#434c5e",
      hover: "#3b4252",
      foreground: "#eceff4",
      mutedForeground: "#a3adc0",
      border: "#3b4252",
      input: "#4c566a",
      ring: "#88c0d0",
      selection: "#ebcb8b",
      graphCanvas: "#242933",
      red: "#bf616a",
      orange: "#d08770",
      yellow: "#ebcb8b",
      green: "#a3be8c",
      cyan: "#88c0d0",
      blue: "#81a1c1",
      purple: "#b48ead",
      pink: "#c895bf",
    },
  },
  {
    // Atom's One Dark
    id: "one-dark",
    name: "One Dark",
    palette: {
      background: "#1b1e23",
      sidebar: "#21252b",
      card: "#282c34",
      popover: "#2c313a",
      control: "#1e2227",
      muted: "#2c313a",
      secondary: "#3e4451",
      hover: "#2f343e",
      foreground: "#d7dae0",
      mutedForeground: "#8b929e",
      border: "#353b45",
      input: "#3e4451",
      ring: "#528bff",
      selection: "#e5c07b",
      graphCanvas: "#1e2227",
      red: "#e06c75",
      orange: "#d19a66",
      yellow: "#e5c07b",
      green: "#98c379",
      cyan: "#56b6c2",
      blue: "#61afef",
      purple: "#c678dd",
      pink: "#e47bb5",
    },
  },
  {
    // Wimer Hazenberg's classic Monokai
    id: "monokai",
    name: "Monokai",
    palette: {
      background: "#1a1b17",
      sidebar: "#1e1f1c",
      card: "#272822",
      popover: "#3e3d32",
      control: "#1e1f1c",
      muted: "#2d2e27",
      secondary: "#49483e",
      hover: "#3e3d32",
      foreground: "#f8f8f2",
      mutedForeground: "#a59f85",
      border: "#3b3c35",
      input: "#49483e",
      ring: "#66d9ef",
      selection: "#fd971f",
      graphCanvas: "#1e1f1c",
      red: "#f92672",
      orange: "#fd971f",
      yellow: "#e6db74",
      green: "#a6e22e",
      cyan: "#66d9ef",
      blue: "#5c9df5",
      purple: "#ae81ff",
      pink: "#f472d0",
    },
  },
  {
    // https://ethanschoonover.com/solarized
    id: "solarized-light",
    name: "Solarized Light",
    palette: {
      background: "#ddd6c1",
      sidebar: "#eee8d5",
      card: "#fdf6e3",
      popover: "#fdf6e3",
      control: "#fffbf0",
      muted: "#f3edda",
      secondary: "#e4ddc8",
      hover: "#e8e1cc",
      foreground: "#073642",
      mutedForeground: "#657b83",
      border: "#e0d9c4",
      input: "#c9c1a9",
      ring: "#268bd2",
      selection: "#cb4b16",
      graphCanvas: "#eee8d5",
      red: "#dc322f",
      orange: "#cb4b16",
      yellow: "#b58900",
      green: "#859900",
      cyan: "#2aa198",
      blue: "#268bd2",
      purple: "#6c71c4",
      pink: "#d33682",
    },
  },
  {
    // https://catppuccin.com (Mocha)
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    palette: {
      background: "#11111b",
      sidebar: "#181825",
      card: "#1e1e2e",
      popover: "#313244",
      control: "#181825",
      muted: "#232334",
      secondary: "#45475a",
      hover: "#313244",
      foreground: "#cdd6f4",
      mutedForeground: "#a6adc8",
      border: "#313244",
      input: "#45475a",
      ring: "#cba6f7",
      selection: "#fab387",
      graphCanvas: "#181825",
      red: "#f38ba8",
      orange: "#fab387",
      yellow: "#f9e2af",
      green: "#a6e3a1",
      cyan: "#94e2d5",
      blue: "#89b4fa",
      purple: "#cba6f7",
      pink: "#f5c2e7",
    },
  },
];

export const BUILT_IN_EDITOR_THEMES: readonly EditorTheme[] = [
  {
    id: DEFAULT_EDITOR_THEME_ID,
    name: "Haptic Dark",
    builtIn: true,
    colors: { ...DEFAULT_COLORS },
  },
  { id: "haptic-white", name: "Haptic White", builtIn: true, colors: HAPTIC_WHITE_COLORS },
  ...PORTED_THEMES.map(({ id, name, palette }) => ({ id, name, builtIn: true, colors: paletteColors(palette) })),
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Known keys with valid colors; anything missing falls back to Haptic Dark. */
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

/** The selected theme, or Haptic Dark when the id no longer exists. */
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

/** Only colors that differ from Haptic Dark are stored and applied. */
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
  // Light themes switch native controls and scrollbars to their light look.
  if (luminance(colors.background) > 0.4) declarations.push("  color-scheme: light;");
  return `:root:root, :root .dark {\n${declarations.join("\n")}\n}\n`;
}

const THEME_STYLE_ELEMENT_ID = "haptic-editor-theme";

/** Applies `theme` to the document; Haptic Dark removes every override. */
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

/** Reads a theme file; unknown colors are ignored and missing ones use Haptic Dark. */
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

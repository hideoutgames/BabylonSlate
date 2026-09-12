import type { InputDevice } from "./input-assets";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KEYBOARD_KEYS = [
  ["ArrowUp", "Up", "Arrows"],
  ["ArrowDown", "Down", "Arrows"],
  ["ArrowLeft", "Left", "Arrows"],
  ["ArrowRight", "Right", "Arrows"],
  ["ShiftLeft", "Left Shift", "Modifiers"],
  ["ShiftRight", "Right Shift", "Modifiers"],
  ["ControlLeft", "Left Ctrl", "Modifiers"],
  ["ControlRight", "Right Ctrl", "Modifiers"],
  ["AltLeft", "Left Alt", "Modifiers"],
  ["AltRight", "Right Alt", "Modifiers"],
  ["MetaLeft", "Left Meta", "Modifiers"],
  ["MetaRight", "Right Meta", "Modifiers"],
  ["CapsLock", "Caps Lock", "Modifiers"],
  ["Home", "Home", "Navigation"],
  ["End", "End", "Navigation"],
  ["PageUp", "Page Up", "Navigation"],
  ["PageDown", "Page Down", "Navigation"],
  ["Insert", "Insert", "Navigation"],
  ["Delete", "Delete", "Navigation"],
  ["NumLock", "Num Lock", "Numpad"],
  ["NumpadDivide", "Numpad /", "Numpad"],
  ["NumpadMultiply", "Numpad *", "Numpad"],
  ["NumpadSubtract", "Numpad -", "Numpad"],
  ["NumpadAdd", "Numpad +", "Numpad"],
  ["NumpadEnter", "Numpad Enter", "Numpad"],
  ["NumpadDecimal", "Numpad .", "Numpad"],
  ["NumpadComma", "Numpad Comma", "Numpad"],
  ["NumpadEqual", "Numpad =", "Numpad"],
  ["NumpadParenLeft", "Numpad (", "Numpad"],
  ["NumpadParenRight", "Numpad )", "Numpad"],
  ["NumpadBackspace", "Numpad Backspace", "Numpad"],
  ["NumpadClear", "Numpad Clear", "Numpad"],
  ["NumpadClearEntry", "Numpad Clear Entry", "Numpad"],
  ["NumpadMemoryAdd", "Numpad Memory Add", "Numpad"],
  ["NumpadMemoryClear", "Numpad Memory Clear", "Numpad"],
  ["NumpadMemoryRecall", "Numpad Memory Recall", "Numpad"],
  ["NumpadMemoryStore", "Numpad Memory Store", "Numpad"],
  ["NumpadMemorySubtract", "Numpad Memory Subtract", "Numpad"],
  ["Backquote", "`", "Punctuation"],
  ["Minus", "-", "Punctuation"],
  ["Equal", "=", "Punctuation"],
  ["BracketLeft", "[", "Punctuation"],
  ["BracketRight", "]", "Punctuation"],
  ["Backslash", "\\", "Punctuation"],
  ["Semicolon", ";", "Punctuation"],
  ["Quote", "'", "Punctuation"],
  ["Comma", ",", "Punctuation"],
  ["Period", ".", "Punctuation"],
  ["Slash", "/", "Punctuation"],
  ["IntlBackslash", "Intl \\", "International"],
  ["IntlRo", "Intl Ro", "International"],
  ["IntlYen", "Intl Yen", "International"],
  ["Convert", "Convert", "International"],
  ["NonConvert", "Non Convert", "International"],
  ["KanaMode", "Kana Mode", "International"],
  ["Lang1", "Language 1", "International"],
  ["Lang2", "Language 2", "International"],
  ["Lang3", "Language 3", "International"],
  ["Lang4", "Language 4", "International"],
  ["Lang5", "Language 5", "International"],
  ["Escape", "Escape", "Other"],
  ["Tab", "Tab", "Other"],
  ["Space", "Space", "Other"],
  ["Enter", "Enter", "Other"],
  ["Backspace", "Backspace", "Other"],
  ["ContextMenu", "Context Menu", "Other"],
  ["PrintScreen", "Print Screen", "Other"],
  ["Pause", "Pause", "Other"],
  ["ScrollLock", "Scroll Lock", "Other"],
  ["Help", "Help", "Other"],
  ["Again", "Again", "Other"],
  ["Copy", "Copy", "Other"],
  ["Cut", "Cut", "Other"],
  ["Find", "Find", "Other"],
  ["Open", "Open", "Other"],
  ["Paste", "Paste", "Other"],
  ["Props", "Properties", "Other"],
  ["Select", "Select", "Other"],
  ["Undo", "Undo", "Other"],
  ["Abort", "Abort", "Other"],
  ["Resume", "Resume", "Other"],
  ["Suspend", "Suspend", "Other"],
  ["Hyper", "Hyper", "Other"],
  ["Super", "Super", "Other"],
  ["Fn", "Fn", "Modifiers"],
  ["FnLock", "Fn Lock", "Modifiers"],
  ["AudioVolumeDown", "Volume Down", "Media"],
  ["AudioVolumeMute", "Mute", "Media"],
  ["AudioVolumeUp", "Volume Up", "Media"],
  ["MediaPlayPause", "Play / Pause", "Media"],
  ["MediaStop", "Media Stop", "Media"],
  ["MediaTrackNext", "Next Track", "Media"],
  ["MediaTrackPrevious", "Previous Track", "Media"],
  ["MediaSelect", "Media Select", "Media"],
  ["Eject", "Eject", "Media"],
  ["LaunchApp1", "Launch App 1", "Media"],
  ["LaunchApp2", "Launch App 2", "Media"],
  ["LaunchMail", "Launch Mail", "Media"],
  ["BrowserBack", "Browser Back", "Browser"],
  ["BrowserForward", "Browser Forward", "Browser"],
  ["BrowserFavorites", "Browser Favorites", "Browser"],
  ["BrowserHome", "Browser Home", "Browser"],
  ["BrowserRefresh", "Browser Refresh", "Browser"],
  ["BrowserSearch", "Browser Search", "Browser"],
  ["BrowserStop", "Browser Stop", "Browser"],
  ["Power", "Power", "Other"],
  ["Sleep", "Sleep", "Other"],
  ["WakeUp", "Wake Up", "Other"],
] as const;

export const INPUT_GAMEPAD_BUTTON_NAMES = [
  "Face Button Down",
  "Face Button Right",
  "Face Button Left",
  "Face Button Up",
  "Left Bumper",
  "Right Bumper",
  "Left Trigger",
  "Right Trigger",
  "Back",
  "Start",
  "Left Stick Click",
  "Right Stick Click",
  "D-Pad Up",
  "D-Pad Down",
  "D-Pad Left",
  "D-Pad Right",
  "Home",
] as const;
export const INPUT_GAMEPAD_AXIS_NAMES = [
  "Left Stick X",
  "Left Stick Y",
  "Right Stick X",
  "Right Stick Y",
] as const;

/** Serialized enum members are stable strings; display labels may change. */
export type InputKey =
  | (typeof KEYBOARD_KEYS)[number][0]
  | `Key${string}`
  | `Digit${number}`
  | `Numpad${number}`
  | `F${number}`
  | "None"
  | "MouseLeft"
  | "MouseMiddle"
  | "MouseRight"
  | "MouseBack"
  | "MouseForward"
  | `Gamepad${number}Button${number}`
  | `Gamepad${number}Axis${number}`;

export interface InputKeyEntry {
  key: InputKey;
  label: string;
  group: string;
  device: InputDevice;
  code: string;
}

/** One catalog drives native Key enums, binding pickers, and physical capture. */
export const INPUT_KEYS: readonly InputKeyEntry[] = [
  { key: "None", label: "None", group: "Other", device: "key", code: "" },
  ...[...LETTERS].map((letter): InputKeyEntry => ({
    key: `Key${letter}`,
    label: letter,
    group: "Letters",
    device: "key",
    code: `Key${letter}`,
  })),
  ...Array.from({ length: 10 }, (_, i): InputKeyEntry => ({
    key: `Digit${i}`,
    label: String(i),
    group: "Digits",
    device: "key",
    code: `Digit${i}`,
  })),
  ...KEYBOARD_KEYS.map(([code, label, group]): InputKeyEntry => ({
    key: code,
    code,
    label,
    group,
    device: "key",
  })),
  ...Array.from({ length: 24 }, (_, i): InputKeyEntry => ({
    key: `F${i + 1}`,
    label: `F${i + 1}`,
    group: "Function",
    device: "key",
    code: `F${i + 1}`,
  })),
  ...Array.from({ length: 10 }, (_, i): InputKeyEntry => ({
    key: `Numpad${i}`,
    label: `Numpad ${i}`,
    group: "Numpad",
    device: "key",
    code: `Numpad${i}`,
  })),
  ...(["Left", "Middle", "Right", "Back", "Forward"] as const).map(
    (name, i): InputKeyEntry => ({
      key: `Mouse${name}`,
      label: `Mouse ${name}`,
      group: "Mouse",
      device: "mouseButton",
      code: String(i),
    }),
  ),
  ...Array.from({ length: 4 }, (_, pad) => [
    ...INPUT_GAMEPAD_BUTTON_NAMES.map((name, i): InputKeyEntry => ({
      key: `Gamepad${pad + 1}Button${i}`,
      label: `Gamepad ${pad + 1} ${name}`,
      group: `Gamepad ${pad + 1}`,
      device: "gamepadButton",
      code: `${pad}:${i}`,
    })),
    ...INPUT_GAMEPAD_AXIS_NAMES.map((name, i): InputKeyEntry => ({
      key: `Gamepad${pad + 1}Axis${i}`,
      label: `Gamepad ${pad + 1} ${name}`,
      group: `Gamepad ${pad + 1}`,
      device: "gamepadAxis",
      code: `${pad}:${i}`,
    })),
  ]).flat(),
];

const BY_KEY = new Map(INPUT_KEYS.map((entry) => [entry.key, entry]));
const BY_CONTROL = new Map(
  INPUT_KEYS.map((entry) => [`${entry.device}:${entry.code}`, entry]),
);

export function inputControlFromKey(
  key: unknown,
): { device: InputDevice; code: string } | null {
  if (typeof key !== "string" || key === "None") return null;
  const entry = BY_KEY.get(key as InputKey);
  return entry ? { device: entry.device, code: entry.code } : null;
}

/** Legacy Pointer controls share the ordinary mouse/touch button keys. */
export function inputKeyFromControl(
  device: InputDevice,
  code: string,
): InputKey | null {
  if (!code) return null;
  if (device === "pointer")
    return inputKeyFromControl("mouseButton", code === "primary" ? "0" : code);
  return BY_CONTROL.get(`${device}:${code}`)?.key ?? null;
}

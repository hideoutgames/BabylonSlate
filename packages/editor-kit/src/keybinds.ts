/**
 * Keyboard chords are stored as canonical strings such as `Mod+Shift+Z`,
 * `Alt+P`, `F2`, or `Delete`. `Mod` is Command on Apple platforms and Control
 * elsewhere; `Ctrl` is only distinct from `Mod` on Apple platforms.
 */
export type KeyChord = string;

export type ChordModifier = "Mod" | "Ctrl" | "Alt" | "Shift";

export interface ParsedChord {
  modifiers: ChordModifier[];
  key: string;
}

export type KeybindEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const MODIFIER_ORDER: readonly ChordModifier[] = ["Mod", "Ctrl", "Alt", "Shift"];

const CODE_KEYS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
};

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  Esc: "Escape",
  Del: "Delete",
  Return: "Enter",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS", "AltGraph", "CapsLock"]);

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent);
}

function normalizeKey(key: string): string {
  const alias = KEY_ALIASES[key] ?? key;
  return alias.length === 1 ? alias.toUpperCase() : alias;
}

export function parseChord(chord: KeyChord): ParsedChord | null {
  const parts = chord.split("+").map((part) => part.trim());
  // `Mod++` binds the plus key itself.
  if (chord.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<ChordModifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ORDER.find(
      (candidate) => candidate.toLowerCase() === part.toLowerCase(),
    );
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key: normalizeKey(key),
  };
}

export function formatChord(parsed: ParsedChord): KeyChord {
  return [...parsed.modifiers, parsed.key].join("+");
}

export function normalizeChord(chord: KeyChord): KeyChord | null {
  const parsed = parseChord(chord);
  return parsed ? formatChord(parsed) : null;
}

function eventKey(event: KeybindEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const code = event.code ?? "";
  // Physical letters and digits keep Alt/Shift from changing the bound key.
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (!event.key || event.key === "Unidentified" || event.key === "Dead") return null;
  return normalizeKey(event.key);
}

/** The canonical chord for a key press, or null for a lone modifier. */
export function chordFromEvent(
  event: KeybindEvent,
  apple: boolean = isApplePlatform(),
): KeyChord | null {
  const key = eventKey(event);
  if (!key) return null;
  const modifiers: ChordModifier[] = [];
  if (apple ? event.metaKey : event.ctrlKey) modifiers.push("Mod");
  if (apple && event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return formatChord({ modifiers, key });
}

export function chordMatchesEvent(
  chord: KeyChord,
  event: KeybindEvent,
  apple: boolean = isApplePlatform(),
): boolean {
  const pressed = chordFromEvent(event, apple);
  return pressed !== null && pressed === normalizeChord(chord);
}

/** Whether the chord uses a command modifier, so it can fire from text fields. */
export function chordHasCommandModifier(chord: KeyChord): boolean {
  const parsed = parseChord(chord);
  return Boolean(parsed?.modifiers.some((modifier) => modifier === "Mod" || modifier === "Ctrl"));
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Delete: "Delete",
  Backspace: "Backspace",
  Enter: "Enter",
  Space: "Space",
  PageUp: "Page Up",
  PageDown: "Page Down",
};

export function modifierLabel(modifier: ChordModifier, apple: boolean): string {
  switch (modifier) {
    case "Mod":
      return apple ? "Command" : "Ctrl";
    case "Ctrl":
      return "Control";
    case "Alt":
      return apple ? "Option" : "Alt";
    case "Shift":
      return "Shift";
  }
}

export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** `aria-keyshortcuts` value using the WAI-ARIA modifier names. */
export function ariaKeyShortcuts(
  chord: KeyChord,
  apple: boolean = isApplePlatform(),
): string | undefined {
  const parsed = parseChord(chord);
  if (!parsed) return undefined;
  const modifiers = parsed.modifiers.map((modifier) =>
    modifier === "Mod"
      ? apple
        ? "Meta"
        : "Control"
      : modifier === "Ctrl"
        ? "Control"
        : modifier,
  );
  return [...modifiers, parsed.key].join("+");
}

/** Readable text for accessible names and plain-text fallbacks. */
export function describeChord(
  chord: KeyChord,
  apple: boolean = isApplePlatform(),
): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  return [
    ...parsed.modifiers.map((modifier) => modifierLabel(modifier, apple)),
    keyLabel(parsed.key),
  ].join("+");
}

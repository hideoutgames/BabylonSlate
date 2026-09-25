import { normalizeChord, type KeyChord } from "@babylonslate/editor-kit";

export type EditorCommandCategory = "General" | "Play" | "Viewport" | "Editing";

export interface EditorCommandDefinition {
  id: EditorCommandId;
  label: string;
  category: EditorCommandCategory;
  defaultChords: readonly KeyChord[];
  /** Commands with a command modifier may also fire from text fields. */
  allowInTextInput?: boolean;
  /** Held keys repeat the command (history stepping). */
  repeat?: boolean;
}

const COMMAND_LIST = [
  { id: "editor.saveAll", label: "Save All", category: "General", defaultChords: ["Mod+S"], allowInTextInput: true },
  { id: "editor.undo", label: "Undo", category: "General", defaultChords: ["Mod+Z"], repeat: true },
  { id: "editor.redo", label: "Redo", category: "General", defaultChords: ["Mod+Shift+Z", "Mod+Y"], repeat: true },
  { id: "editor.search", label: "Search Project", category: "General", defaultChords: ["Mod+K"], allowInTextInput: true },
  { id: "editor.focusLayout", label: "Toggle Focus", category: "General", defaultChords: ["Mod+Shift+F"] },
  { id: "editor.projectSettings", label: "Project Settings", category: "General", defaultChords: [] },
  { id: "editor.engineSettings", label: "Engine Settings", category: "General", defaultChords: ["Mod+,"], allowInTextInput: true },
  { id: "play.start", label: "Play", category: "Play", defaultChords: ["Alt+P"] },
  { id: "graph.compile", label: "Compile", category: "Play", defaultChords: ["F7"] },
  { id: "viewport.translate", label: "Move Tool", category: "Viewport", defaultChords: ["1"] },
  { id: "viewport.rotate", label: "Rotate Tool", category: "Viewport", defaultChords: ["2"] },
  { id: "viewport.scale", label: "Scale Tool", category: "Viewport", defaultChords: ["3"] },
  { id: "viewport.frameSelection", label: "Frame Selection", category: "Viewport", defaultChords: ["F"] },
  { id: "edit.duplicate", label: "Duplicate", category: "Editing", defaultChords: ["Mod+D"] },
  { id: "edit.rename", label: "Rename", category: "Editing", defaultChords: ["F2"] },
  { id: "edit.delete", label: "Delete", category: "Editing", defaultChords: ["Delete", "Backspace"] },
] as const;

export type EditorCommandId = (typeof COMMAND_LIST)[number]["id"];

export const EDITOR_COMMANDS: readonly EditorCommandDefinition[] = COMMAND_LIST;

export const EDITOR_COMMAND_CATEGORIES: readonly EditorCommandCategory[] = [
  "General",
  "Play",
  "Viewport",
  "Editing",
];

const COMMANDS_BY_ID = new Map<string, EditorCommandDefinition>(
  EDITOR_COMMANDS.map((command) => [command.id, command]),
);

export function editorCommand(id: string): EditorCommandDefinition | undefined {
  return COMMANDS_BY_ID.get(id);
}

export type KeybindOverrides = Readonly<Record<string, readonly string[]>>;
export type ResolvedKeybinds = ReadonlyMap<EditorCommandId, readonly KeyChord[]>;

function uniqueChords(chords: readonly string[]): KeyChord[] {
  const normalized = chords
    .map((chord) => normalizeChord(chord))
    .filter((chord): chord is KeyChord => chord !== null);
  return [...new Set(normalized)];
}

/** Effective chords per command: saved overrides replace defaults. */
export function resolveKeybinds(overrides: KeybindOverrides = {}): ResolvedKeybinds {
  return new Map(
    EDITOR_COMMANDS.map((command) => [
      command.id,
      uniqueChords(overrides[command.id] ?? command.defaultChords),
    ]),
  );
}

/** Other commands already using `chord`, so the settings UI can warn. */
export function keybindConflicts(
  bindings: ResolvedKeybinds,
  commandId: EditorCommandId,
  chord: KeyChord,
): EditorCommandId[] {
  const target = normalizeChord(chord);
  if (!target) return [];
  return [...bindings]
    .filter(([id, chords]) => id !== commandId && chords.includes(target))
    .map(([id]) => id);
}

/**
 * Store only commands that differ from their defaults so later default
 * changes still reach users who never customized that command.
 */
export function withKeybindOverride(
  overrides: KeybindOverrides,
  commandId: EditorCommandId,
  chords: readonly KeyChord[] | null,
): Record<string, string[]> {
  const next: Record<string, string[]> = Object.fromEntries(
    Object.entries(overrides).map(([id, value]) => [id, [...value]]),
  );
  const defaults = editorCommand(commandId)?.defaultChords ?? [];
  const normalized = chords === null ? null : uniqueChords(chords);
  if (
    normalized === null ||
    (normalized.length === defaults.length &&
      normalized.every((chord, index) => chord === defaults[index]))
  ) {
    delete next[commandId];
  } else {
    next[commandId] = normalized;
  }
  return next;
}

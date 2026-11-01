import { chordStartsWith, normalizeChord, type KeyChord } from "@haptic/editor-kit";

export type EditorCommandCategory = "General" | "Documents" | "Play" | "Viewport" | "Editing" | "Timeline" | "Content Browser";

export interface EditorCommandDefinition {
  id: EditorCommandId;
  label: string;
  category: EditorCommandCategory;
  defaultChords: readonly KeyChord[];
  /** Commands with a command modifier may also fire from text fields. */
  allowInTextInput?: boolean;
  /** Held keys repeat the command (history stepping). */
  repeat?: boolean;
  /** The chord's browser action (Save Page As) never runs, even when the command cannot. */
  blocksBrowserDefault?: boolean;
}

/** How long a multi-step shortcut, or its recording, waits for the next step. */
export const KEY_SEQUENCE_TIMEOUT_MS = 1500;

const COMMAND_LIST = [
  { id: "editor.saveAll", label: "Save All", category: "General", defaultChords: ["Mod+S"], allowInTextInput: true, blocksBrowserDefault: true },
  { id: "editor.undo", label: "Undo", category: "General", defaultChords: ["Mod+Z"], repeat: true },
  { id: "editor.redo", label: "Redo", category: "General", defaultChords: ["Mod+Shift+Z", "Mod+Y"], repeat: true },
  { id: "editor.search", label: "Search Project", category: "General", defaultChords: ["Mod+K"], allowInTextInput: true },
  { id: "editor.focusLayout", label: "Toggle Focus", category: "General", defaultChords: ["Mod+Shift+F"] },
  { id: "editor.projectSettings", label: "Project Settings", category: "General", defaultChords: ["Mod+Shift+,"] },
  { id: "editor.engineSettings", label: "Engine Settings", category: "General", defaultChords: ["Mod+,"], allowInTextInput: true },
  // Three modifiers, so closing the project never happens from a stray chord.
  { id: "editor.projectBrowser", label: "Project Browser", category: "General", defaultChords: ["Mod+Alt+Shift+B"] },
  { id: "editor.contentBrowser", label: "Content Browser", category: "General", defaultChords: ["Alt+B"] },
  { id: "document.close", label: "Close Document", category: "Documents", defaultChords: ["Alt+W"] },
  { id: "document.closeAll", label: "Close Open Tabs", category: "Documents", defaultChords: ["Alt+Shift+W"] },
  { id: "document.next", label: "Next Document", category: "Documents", defaultChords: ["Alt+PageDown"] },
  { id: "document.previous", label: "Previous Document", category: "Documents", defaultChords: ["Alt+PageUp"] },
  { id: "play.start", label: "Play", category: "Play", defaultChords: ["Alt+P"] },
  { id: "graph.compile", label: "Compile", category: "Play", defaultChords: ["F7"] },
  { id: "graph.toggleBreakpoint", label: "Toggle Breakpoint", category: "Play", defaultChords: ["F9"] },
  { id: "viewport.translate", label: "Move Tool", category: "Viewport", defaultChords: ["1"] },
  { id: "viewport.rotate", label: "Rotate Tool", category: "Viewport", defaultChords: ["2"] },
  { id: "viewport.scale", label: "Scale Tool", category: "Viewport", defaultChords: ["3"] },
  { id: "viewport.frameSelection", label: "Frame Selection", category: "Viewport", defaultChords: ["F"] },
  { id: "viewport.toggleSnap", label: "Toggle Snap Grid", category: "Viewport", defaultChords: ["G"] },
  { id: "viewport.toggleGrid", label: "Toggle Grid", category: "Viewport", defaultChords: ["Shift+G"] },
  { id: "viewport.toggleCollisions", label: "Toggle Collisions", category: "Viewport", defaultChords: ["Alt+C"] },
  { id: "viewport.toggleNavmesh", label: "Toggle Navmesh", category: "Viewport", defaultChords: ["Shift+N"] },
  { id: "viewport.toggleGameCamera", label: "Toggle Game Camera", category: "Viewport", defaultChords: ["Shift+C"] },
  { id: "viewport.toggleDragSelect", label: "Toggle Drag Select", category: "Viewport", defaultChords: ["Q"] },
  { id: "viewport.toggleMode", label: "Switch 2D / 3D", category: "Viewport", defaultChords: ["Alt+V"] },
  { id: "viewport.drop", label: "Drop Selection", category: "Viewport", defaultChords: ["End"] },
  { id: "scene.modeDesign", label: "Design Mode", category: "Viewport", defaultChords: ["Shift+1"] },
  { id: "scene.modeLandscape", label: "Landscape Mode", category: "Viewport", defaultChords: ["Shift+2"] },
  { id: "scene.modeFoliage", label: "Foliage Mode", category: "Viewport", defaultChords: ["Shift+3"] },
  { id: "scene.modeScript", label: "Script Mode", category: "Viewport", defaultChords: ["Shift+4"] },
  { id: "scene.modeTimeline", label: "Timeline Mode", category: "Viewport", defaultChords: ["Shift+5"] },
  { id: "edit.copy", label: "Copy", category: "Editing", defaultChords: ["Mod+C"] },
  { id: "edit.paste", label: "Paste", category: "Editing", defaultChords: ["Mod+V"] },
  { id: "edit.duplicate", label: "Duplicate", category: "Editing", defaultChords: ["Mod+D"] },
  { id: "edit.rename", label: "Rename", category: "Editing", defaultChords: ["F2"] },
  { id: "edit.delete", label: "Delete", category: "Editing", defaultChords: ["Delete", "Backspace"] },
  { id: "edit.find", label: "Search Panel", category: "Editing", defaultChords: ["Mod+F"], allowInTextInput: true },
  { id: "edit.newFolder", label: "New Folder", category: "Editing", defaultChords: ["Alt+Shift+N"] },
  { id: "scene.placeActor", label: "Place Actors", category: "Editing", defaultChords: ["Alt+A"] },
  { id: "timeline.setKey", label: "Set Key", category: "Timeline", defaultChords: ["K"] },
  { id: "timeline.previousKey", label: "Previous Key", category: "Timeline", defaultChords: ["["] },
  { id: "timeline.nextKey", label: "Next Key", category: "Timeline", defaultChords: ["]"] },
  { id: "timeline.addSelectedActors", label: "Add Selected Actors", category: "Timeline", defaultChords: ["Shift+A"] },
  { id: "browser.newAsset", label: "New Asset", category: "Content Browser", defaultChords: ["Alt+N"] },
  { id: "browser.import", label: "Import Assets", category: "Content Browser", defaultChords: ["Alt+I"] },
  { id: "browser.references", label: "Show References", category: "Content Browser", defaultChords: ["Alt+R"] },
] as const;

export type EditorCommandId = (typeof COMMAND_LIST)[number]["id"];

export const EDITOR_COMMANDS: readonly EditorCommandDefinition[] = COMMAND_LIST;

export const EDITOR_COMMAND_CATEGORIES: readonly EditorCommandCategory[] = [
  "General",
  "Documents",
  "Play",
  "Viewport",
  "Editing",
  "Timeline",
  "Content Browser",
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

/**
 * Other commands already using `chord`, so the settings UI can warn. A chord
 * that begins another command's multi-step shortcut also conflicts: the
 * multi-step shortcut waits for its next step and the shorter one never runs.
 */
export function keybindConflicts(
  bindings: ResolvedKeybinds,
  commandId: EditorCommandId,
  chord: KeyChord,
): EditorCommandId[] {
  const target = normalizeChord(chord);
  if (!target) return [];
  const overlaps = (other: KeyChord) =>
    other === target || chordStartsWith(other, target) || chordStartsWith(target, other);
  return [...bindings]
    .filter(([id, chords]) => id !== commandId && chords.some(overlaps))
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

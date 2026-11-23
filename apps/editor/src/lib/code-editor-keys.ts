import { chordSteps, parseChord, type KeyChord } from "@haptic/editor-kit";

/**
 * The CodeMirror key name for a catalog chord (`Ctrl+Space` → `Ctrl-Space`),
 * or null for one CodeMirror cannot take. Kept free of CodeMirror so the
 * editor route never loads it.
 *
 * - `Mod` stays `Mod` (Command on Apple, Control elsewhere) and `Ctrl` stays
 *   the Control key on every platform, as in the catalog.
 * - CodeMirror matches letters by the typed character, falling back to the
 *   physical key only with Control, Command or (outside macOS) Option held, so
 *   a letter is lower case except under Shift alone, where it is the typed
 *   capital.
 * - Multi-step chords give null: CodeMirror throws on every key press once a
 *   sequence's first step is also a single-key binding in any of the editor's
 *   keymaps, and it waits 4 s, not `KEY_SEQUENCE_TIMEOUT_MS`, for the next step.
 */
export function codeMirrorKey(chord: KeyChord): string | null {
  if (chordSteps(chord).length !== 1) return null;
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const shiftOnly = parsed.modifiers.length === 1 && parsed.modifiers[0] === "Shift";
  const key = /^[A-Z]$/.test(parsed.key) && !shiftOnly ? parsed.key.toLowerCase() : parsed.key;
  return [...parsed.modifiers, key].join("-");
}

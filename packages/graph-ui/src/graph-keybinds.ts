import { createContext } from "react";
import {
  chordFromEvent,
  type KeybindEvent,
  type KeyChord,
} from "@haptic/editor-kit";

export type GraphCommand = "copy" | "paste" | "duplicate" | "delete";

/** Chords per graph command, in the canonical form `chordFromEvent` produces. */
export type GraphKeybinds = Readonly<Record<GraphCommand, readonly KeyChord[]>>;

export const DEFAULT_GRAPH_KEYBINDS: GraphKeybinds = {
  copy: ["Mod+C"],
  paste: ["Mod+V"],
  duplicate: ["Mod+D"],
  delete: ["Delete", "Backspace"],
};

/**
 * The editor supplies the user's Copy, Paste, Duplicate and Delete chords from
 * its keybind settings. A graph outside the editor keeps the defaults.
 */
export const GraphKeybindsContext = createContext<GraphKeybinds>(DEFAULT_GRAPH_KEYBINDS);

const GRAPH_COMMANDS: readonly GraphCommand[] = ["copy", "paste", "duplicate", "delete"];

/** The graph command bound to a key press, or null. */
export function graphCommandForEvent(
  event: KeybindEvent,
  keybinds: GraphKeybinds,
  apple?: boolean,
): GraphCommand | null {
  const chord = chordFromEvent(event, apple);
  if (!chord) return null;
  return GRAPH_COMMANDS.find((command) => keybinds[command].includes(chord)) ?? null;
}

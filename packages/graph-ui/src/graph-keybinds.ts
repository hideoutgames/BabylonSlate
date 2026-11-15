import { createContext } from "react";
import {
  chordFromEvent,
  type KeybindEvent,
  type KeyChord,
} from "@haptic/editor-kit";

export type GraphCommand =
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "breakLinks"
  | "toggleBreakpoint"
  | "toggleBreakpointEnabled"
  | "editBreakpoint";

/** Chords per graph command, in the canonical form `chordFromEvent` produces. */
export type GraphKeybinds = Readonly<Record<GraphCommand, readonly KeyChord[]>>;

export const DEFAULT_GRAPH_KEYBINDS: GraphKeybinds = {
  copy: ["Mod+C"],
  paste: ["Mod+V"],
  duplicate: ["Mod+D"],
  delete: ["Delete", "Backspace"],
  breakLinks: ["Alt+L"],
  toggleBreakpoint: ["F9"],
  toggleBreakpointEnabled: ["Mod+F9"],
  editBreakpoint: ["Shift+F9"],
};

/**
 * The editor supplies the user's chords for every graph command (the node menu's actions) from its
 * keybind settings. A graph outside the editor keeps the defaults.
 */
export const GraphKeybindsContext = createContext<GraphKeybinds>(DEFAULT_GRAPH_KEYBINDS);

const GRAPH_COMMANDS = Object.keys(DEFAULT_GRAPH_KEYBINDS) as GraphCommand[];

/** Commands that change breakpoints, not the graph, so a read-only canvas (a running Simulation) still takes them. */
export const BREAKPOINT_GRAPH_COMMANDS: ReadonlySet<GraphCommand> = new Set([
  "toggleBreakpoint",
  "toggleBreakpointEnabled",
  "editBreakpoint",
]);

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

/** Built-in engine enum for Play / player pointer vs HUD routing. */

export const ENGINE_INPUT_MODE_ENUM_ID = "engine:InputMode";

export const INPUT_MODE_MEMBERS = ["All", "Interface", "Game"] as const;

export type InputMode = (typeof INPUT_MODE_MEMBERS)[number];

export const DEFAULT_INPUT_MODE: InputMode = "All";

const MEMBER_SET = new Set<string>(INPUT_MODE_MEMBERS);

export function parseInputMode(value: unknown): InputMode {
  if (typeof value === "string" && MEMBER_SET.has(value)) {
    return value as InputMode;
  }
  return DEFAULT_INPUT_MODE;
}

/** Keyboard, pointer, and gamepad into the action/axis resolver. */
export function inputModeAllowsGameInput(mode: InputMode): boolean {
  return mode !== "Interface";
}

/** Authored Hit Testable GUI picks. Game mode paints HUD but does not pick. */
export function inputModeAllowsGuiHits(mode: InputMode): boolean {
  return mode !== "Game";
}

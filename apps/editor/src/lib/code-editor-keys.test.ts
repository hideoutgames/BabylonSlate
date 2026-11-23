import { describe, expect, it } from "vitest";
import { codeMirrorKey } from "./code-editor-keys";

describe("codeMirrorKey", () => {
  it.each([
    // Control on every platform, Command or Control by platform.
    ["Ctrl+Space", "Ctrl-Space"],
    ["Mod+Space", "Mod-Space"],
    ["Enter", "Enter"],
    ["Escape", "Escape"],
    ["Tab", "Tab"],
    ["F2", "F2"],
    ["Shift+F9", "Shift-F9"],
    // CodeMirror names a letter by its typed character: lower case, or the capital Shift alone types.
    ["K", "k"],
    ["Alt+K", "Alt-k"],
    ["Mod+Alt+Shift+B", "Mod-Alt-Shift-b"],
    ["Shift+K", "Shift-K"],
    ["Alt+1", "Alt-1"],
    ["Mod+,", "Mod-,"],
    ["Ctrl+-", "Ctrl--"],
    ["[", "["],
    // Aliases are read through the catalog's own parser.
    ["Esc", "Escape"],
  ])("maps %s to %s", (chord, key) => {
    expect(codeMirrorKey(chord)).toBe(key);
  });

  it("binds nothing for multi-step or unparseable chords", () => {
    expect(codeMirrorKey("Mod+K Mod+C")).toBeNull();
    expect(codeMirrorKey("Hyper+K")).toBeNull();
    expect(codeMirrorKey("")).toBeNull();
  });
});

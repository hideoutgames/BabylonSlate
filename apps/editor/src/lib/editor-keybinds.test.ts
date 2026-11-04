import { describe, expect, it } from "vitest";
import {
  EDITOR_COMMANDS,
  keybindConflicts,
  resolveKeybinds,
  withKeybindOverride,
} from "./editor-keybinds";

describe("resolveKeybinds", () => {
  it("uses defaults, replaced wholesale by a saved override", () => {
    const bindings = resolveKeybinds({ "editor.redo": ["Mod+Shift+Y"] });
    expect(bindings.get("editor.undo")).toEqual(["Mod+Z"]);
    expect(bindings.get("editor.redo")).toEqual(["Mod+Shift+Y"]);
  });

  it("drops unparseable chords and keeps an explicit unassignment", () => {
    const bindings = resolveKeybinds({
      "edit.rename": ["Hyper+R", "shift+F2"],
      "edit.delete": [],
    });
    expect(bindings.get("edit.rename")).toEqual(["Shift+F2"]);
    expect(bindings.get("edit.delete")).toEqual([]);
  });
});

describe("withKeybindOverride", () => {
  it("stores only commands that differ from their defaults", () => {
    const custom = withKeybindOverride({}, "edit.rename", ["Mod+R"]);
    expect(custom).toEqual({ "edit.rename": ["Mod+R"] });
    expect(withKeybindOverride(custom, "edit.rename", ["F2"])).toEqual({});
    expect(withKeybindOverride(custom, "edit.rename", null)).toEqual({});
  });

  it("records an empty list when a command is unassigned", () => {
    expect(withKeybindOverride({}, "play.start", [])).toEqual({ "play.start": [] });
  });
});

describe("keybindConflicts", () => {
  it("lists other commands already using the chord", () => {
    const bindings = resolveKeybinds();
    expect(keybindConflicts(bindings, "edit.rename", "mod+z")).toEqual(["editor.undo"]);
    expect(keybindConflicts(bindings, "editor.undo", "Mod+Z")).toEqual([]);
  });

  it("gives no default chord a clash with a command that acts beside it", () => {
    const bindings = resolveKeybinds();
    for (const command of EDITOR_COMMANDS) {
      for (const chord of command.defaultChords) {
        expect(keybindConflicts(bindings, command.id, chord), `${command.id} ${chord}`).toEqual([]);
      }
    }
  });

  it("lets Tilemap Paint tools share keys with commands that never act in a Tilemap, and no others", () => {
    const bindings = resolveKeybinds();
    // Bucket Tool and Toggle Snap Grid both default to G: a Tilemap document has no viewport.
    expect(keybindConflicts(bindings, "tilemapPaint.bucket", "G")).toEqual([]);
    expect(keybindConflicts(bindings, "viewport.toggleSnap", "G")).toEqual([]);
    expect(keybindConflicts(bindings, "timeline.setKey", "B")).toEqual([]);
    expect(keybindConflicts(bindings, "browser.newAsset", "B")).toEqual([]);
    // Global and Editing commands, and the other tools, act in Paint too.
    expect(keybindConflicts(bindings, "tilemapPaint.brush", "Mod+S")).toEqual(["editor.saveAll"]);
    expect(keybindConflicts(bindings, "tilemapPaint.brush", "Delete")).toEqual(["edit.delete"]);
    expect(keybindConflicts(bindings, "tilemapPaint.brush", "E")).toEqual(["tilemapPaint.eraser"]);
    expect(keybindConflicts(bindings, "edit.rename", "S")).toEqual(["tilemapPaint.select"]);
  });
});

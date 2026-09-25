import { describe, expect, it } from "vitest";
import {
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
});

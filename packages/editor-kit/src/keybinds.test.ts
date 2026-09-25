import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcuts,
  chordFromEvent,
  chordHasCommandModifier,
  describeChord,
  normalizeChord,
  type KeybindEvent,
} from "./keybinds";

function press(init: Partial<KeybindEvent> & { key: string; code?: string }): KeybindEvent {
  return {
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  };
}

describe("chordFromEvent", () => {
  it("maps Command on Apple and Control elsewhere to Mod", () => {
    expect(chordFromEvent(press({ key: "z", code: "KeyZ", metaKey: true }), true)).toBe("Mod+Z");
    expect(chordFromEvent(press({ key: "z", code: "KeyZ", ctrlKey: true }), false)).toBe("Mod+Z");
    expect(chordFromEvent(press({ key: "z", code: "KeyZ", ctrlKey: true }), true)).toBe("Ctrl+Z");
  });

  it("uses the physical key so Option and Shift do not change the letter", () => {
    expect(chordFromEvent(press({ key: "π", code: "KeyP", altKey: true }), true)).toBe("Alt+P");
    expect(
      chordFromEvent(press({ key: "Z", code: "KeyZ", metaKey: true, shiftKey: true }), true),
    ).toBe("Mod+Shift+Z");
    expect(chordFromEvent(press({ key: "<", code: "Comma", metaKey: true }), true)).toBe("Mod+,");
  });

  it("returns null while only a modifier is held", () => {
    expect(chordFromEvent(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }), false)).toBeNull();
    expect(chordFromEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), true)).toBeNull();
  });

  it("keeps named keys such as F2 and Delete", () => {
    expect(chordFromEvent(press({ key: "F2", code: "F2" }), false)).toBe("F2");
    expect(chordFromEvent(press({ key: "Delete", code: "Delete" }), false)).toBe("Delete");
  });
});

describe("normalizeChord", () => {
  it("orders modifiers canonically and resolves aliases", () => {
    expect(normalizeChord("Shift+Mod+z")).toBe("Mod+Shift+Z");
    expect(normalizeChord("Esc")).toBe("Escape");
    expect(normalizeChord("Mod++")).toBe("Mod++");
  });

  it("rejects unknown modifiers so bad saved data is ignored", () => {
    expect(normalizeChord("Hyper+K")).toBeNull();
    expect(normalizeChord("")).toBeNull();
  });
});

describe("chord descriptions", () => {
  it("names Mod per platform for screen readers and aria-keyshortcuts", () => {
    expect(describeChord("Mod+Shift+Z", true)).toBe("Command+Shift+Z");
    expect(describeChord("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(ariaKeyShortcuts("Mod+S", true)).toBe("Meta+S");
    expect(ariaKeyShortcuts("Mod+S", false)).toBe("Control+S");
  });

  it("treats only Mod and Ctrl as command modifiers", () => {
    expect(chordHasCommandModifier("Mod+S")).toBe(true);
    expect(chordHasCommandModifier("Alt+P")).toBe(false);
    expect(chordHasCommandModifier("F")).toBe(false);
  });
});

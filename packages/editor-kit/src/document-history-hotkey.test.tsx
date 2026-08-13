import { afterEach, describe, expect, it } from "vitest";
import { documentHistoryHotkey } from "./document-history-hotkey";

function keyEvent(
  init: Partial<KeyboardEvent> & { key: string },
  target?: Element,
): Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target"
> {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: target ?? document.body,
  };
}

describe("documentHistoryHotkey", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("maps Mod+Z to undo and Mod+Shift+Z or Mod+Y to redo", () => {
    expect(documentHistoryHotkey(keyEvent({ key: "z", metaKey: true }))).toBe(
      "undo",
    );
    expect(documentHistoryHotkey(keyEvent({ key: "z", ctrlKey: true }))).toBe(
      "undo",
    );
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true, shiftKey: true })),
    ).toBe("redo");
    expect(documentHistoryHotkey(keyEvent({ key: "y", ctrlKey: true }))).toBe(
      "redo",
    );
    expect(documentHistoryHotkey(keyEvent({ key: "y", metaKey: true }))).toBe(
      "redo",
    );
  });

  it("ignores keys without a modifier and Alt+Mod combinations", () => {
    expect(documentHistoryHotkey(keyEvent({ key: "z" }))).toBeNull();
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true, altKey: true })),
    ).toBeNull();
    expect(documentHistoryHotkey(keyEvent({ key: "k", metaKey: true }))).toBeNull();
  });

  it("leaves typing undo in inputs and SelectableText", () => {
    const field = document.createElement("input");
    document.body.append(field);
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true }, field)),
    ).toBeNull();

    const wrap = document.createElement("span");
    wrap.className = "selectable-text";
    const child = document.createElement("span");
    wrap.append(child);
    document.body.append(wrap);
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true }, child)),
    ).toBeNull();
  });

  it("ignores the shortcut while a three-pointer gesture is active", () => {
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true }), {
        activePointerCount: 3,
      }),
    ).toBeNull();
    expect(
      documentHistoryHotkey(keyEvent({ key: "z", metaKey: true }), {
        activePointerCount: 2,
      }),
    ).toBe("undo");
  });
});

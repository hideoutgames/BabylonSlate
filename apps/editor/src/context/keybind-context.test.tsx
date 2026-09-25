import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { KeybindProvider, useKeybindCommand } from "./keybind-context";
import type { EditorCommandId } from "../lib/editor-keybinds";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function Command({
  id,
  run,
  enabled,
}: {
  id: EditorCommandId;
  run: () => void;
  enabled?: boolean;
}) {
  useKeybindCommand(id, run, { enabled });
  return null;
}

function FocusScoped({ run }: { run: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeybindCommand("edit.delete", run, { focusWithinRef: ref });
  return (
    <div ref={ref}>
      <button type="button">Row</button>
    </div>
  );
}

const ctrl = (key: string) => ({ key: key.toLowerCase(), code: `Key${key}`, ctrlKey: true });

describe("KeybindProvider", () => {
  it("runs undo on Mod+Z and redo on either redo chord", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    render(
      <KeybindProvider>
        <Command id="editor.undo" run={undo} />
        <Command id="editor.redo" run={redo} />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, ctrl("Z"));
    fireEvent.keyDown(document.body, { ...ctrl("Z"), shiftKey: true });
    fireEvent.keyDown(document.body, ctrl("Y"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it("leaves text-field undo native but still saves from a field", () => {
    const undo = vi.fn();
    const save = vi.fn();
    const { getByRole } = render(
      <KeybindProvider>
        <Command id="editor.undo" run={undo} />
        <Command id="editor.saveAll" run={save} />
        <input aria-label="Name" />
      </KeybindProvider>,
    );
    const field = getByRole("textbox");
    const undoEvent = fireEvent.keyDown(field, ctrl("Z"));
    fireEvent.keyDown(field, ctrl("S"));
    expect(undoEvent).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores commands while a modal dialog is open or play is running", () => {
    const save = vi.fn();
    const { rerender } = render(
      <KeybindProvider>
        <Command id="editor.saveAll" run={save} />
        <div role="dialog" aria-modal="true" />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, ctrl("S"));
    rerender(
      <KeybindProvider suspended>
        <Command id="editor.saveAll" run={save} />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, ctrl("S"));
    expect(save).not.toHaveBeenCalled();
  });

  it("falls back to an older registration when the newest is disabled", () => {
    const older = vi.fn();
    const newer = vi.fn();
    render(
      <KeybindProvider>
        <Command id="edit.rename" run={older} />
        <Command id="edit.rename" run={newer} enabled={false} />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, { key: "F2", code: "F2" });
    expect(newer).not.toHaveBeenCalled();
    expect(older).toHaveBeenCalledTimes(1);
  });

  it("fires focus-scoped deletes only while focus is inside that surface", () => {
    const remove = vi.fn();
    const { getByRole } = render(
      <KeybindProvider>
        <FocusScoped run={remove} />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, { key: "Delete", code: "Delete" });
    expect(remove).not.toHaveBeenCalled();
    const row = getByRole("button", { name: "Row" });
    row.focus();
    fireEvent.keyDown(row, { key: "Delete", code: "Delete" });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

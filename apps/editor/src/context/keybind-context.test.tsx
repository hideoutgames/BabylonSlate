import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useContext, useRef } from "react";
import { GraphKeybindsContext } from "@haptic/graph-ui";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@haptic/ui/components/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@haptic/ui/components/dialog";
import { Sheet, SheetContent, SheetTitle } from "@haptic/ui/components/sheet";
import { MemoryAppSettingsStore, defaultEngineSettings } from "@haptic/vfs";
import { AppSettingsProvider } from "./app-settings-context";
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
  allowInModal,
}: {
  id: EditorCommandId;
  run: () => void;
  enabled?: boolean;
  allowInModal?: boolean;
}) {
  useKeybindCommand(id, run, { enabled, allowInModal });
  return null;
}

function ModalDialog({ open = true, modal }: { open?: boolean; modal?: boolean }) {
  return (
    <Dialog open={open} modal={modal}>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
      </DialogContent>
    </Dialog>
  );
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

  it("ignores commands while play is running", () => {
    const save = vi.fn();
    render(
      <KeybindProvider suspended>
        <Command id="editor.saveAll" run={save} />
      </KeybindProvider>,
    );
    fireEvent.keyDown(document.body, ctrl("S"));
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ["Dialog", <ModalDialog key="dialog" />],
    [
      "AlertDialog",
      <AlertDialog key="alert" open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete Actors?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    ],
    [
      "modal Sheet",
      <Sheet key="sheet" open>
        <SheetContent>
          <SheetTitle>Folders</SheetTitle>
        </SheetContent>
      </Sheet>,
    ],
  ])("suspends every command behind an open %s", async (_name, modal) => {
    const undo = vi.fn();
    const focus = vi.fn();
    const search = vi.fn();
    render(
      <KeybindProvider>
        <Command id="editor.undo" run={undo} />
        <Command id="editor.focusLayout" run={focus} />
        <Command id="editor.search" run={search} />
        {modal}
      </KeybindProvider>,
    );
    await screen.findByText(/Settings|Delete Actors\?|Folders/);
    fireEvent.keyDown(document.body, ctrl("Z"));
    fireEvent.keyDown(document.body, { ...ctrl("F"), shiftKey: true });
    fireEvent.keyDown(document.body, ctrl("K"));
    expect(undo).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("resumes commands once the dialog has closed", async () => {
    const undo = vi.fn();
    const tree = (open: boolean) => (
      <KeybindProvider>
        <Command id="editor.undo" run={undo} />
        <ModalDialog open={open} />
      </KeybindProvider>
    );
    const { rerender } = render(tree(true));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.body, ctrl("Z"));
    expect(undo).not.toHaveBeenCalled();
    rerender(tree(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(document.body, ctrl("Z"));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("does not hold commands back for a dialog that is still animating closed", async () => {
    const undo = vi.fn();
    // A pending animation keeps the closing popup mounted, as the real exit does.
    const getAnimations = vi.fn(() => [{ finished: new Promise(() => undefined) }]);
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: getAnimations });
    try {
      const tree = (open: boolean) => (
        <KeybindProvider>
          <Command id="editor.undo" run={undo} />
          <ModalDialog open={open} />
        </KeybindProvider>
      );
      const { rerender } = render(tree(true));
      await screen.findByRole("dialog");
      rerender(tree(false));
      await waitFor(() => expect(document.querySelector('[role="dialog"][data-closed]')).not.toBeNull());
      fireEvent.keyDown(document.body, ctrl("Z"));
      expect(undo).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(Element.prototype, "getAnimations");
    }
  });

  it("leaves commands alone behind nonmodal popups", async () => {
    const undo = vi.fn();
    render(
      <KeybindProvider>
        <Command id="editor.undo" run={undo} />
        <ModalDialog modal={false} />
        <Sheet open modal={false}>
          <SheetContent showOverlay={false}>
            <SheetTitle>Console</SheetTitle>
          </SheetContent>
        </Sheet>
      </KeybindProvider>,
    );
    await screen.findByText("Console");
    fireEvent.keyDown(document.body, ctrl("Z"));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("lets a command that closes its own modal run while that modal is open", async () => {
    const search = vi.fn();
    const undo = vi.fn();
    render(
      <KeybindProvider>
        <Command id="editor.search" run={search} allowInModal />
        <Command id="editor.undo" run={undo} />
        <ModalDialog />
      </KeybindProvider>,
    );
    await screen.findByRole("dialog");
    fireEvent.keyDown(document.body, ctrl("K"));
    fireEvent.keyDown(document.body, ctrl("Z"));
    expect(search).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  it("keeps the browser's Save Page action off Save All's chord when nothing saves", async () => {
    const save = vi.fn();
    const { rerender } = render(
      <KeybindProvider>
        <Command id="editor.saveAll" run={save} enabled={false} />
      </KeybindProvider>,
    );
    expect(fireEvent.keyDown(document.body, ctrl("S"))).toBe(false);
    rerender(
      <KeybindProvider>
        <Command id="editor.saveAll" run={save} />
        <ModalDialog />
      </KeybindProvider>,
    );
    await screen.findByRole("dialog");
    expect(fireEvent.keyDown(document.body, ctrl("S"))).toBe(false);
    rerender(
      <KeybindProvider suspended>
        <Command id="editor.saveAll" run={save} />
      </KeybindProvider>,
    );
    expect(fireEvent.keyDown(document.body, ctrl("S"))).toBe(false);
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

  it("hands graph canvases the Copy, Paste, Duplicate, Delete and Toggle Breakpoint chords, customized or not", async () => {
    function Chords() {
      return <span data-testid="chords">{JSON.stringify(useContext(GraphKeybindsContext))}</span>;
    }
    const defaults = render(<KeybindProvider><Chords /></KeybindProvider>);
    expect(JSON.parse(defaults.getByTestId("chords").textContent!)).toEqual({
      copy: ["Mod+C"],
      paste: ["Mod+V"],
      duplicate: ["Mod+D"],
      delete: ["Delete", "Backspace"],
      toggleBreakpoint: ["F9"],
    });
    defaults.unmount();

    const store = new MemoryAppSettingsStore();
    await store.save({ ...defaultEngineSettings(), keybinds: { "edit.duplicate": ["Alt+Shift+D"], "edit.copy": [] } });
    render(<AppSettingsProvider store={store}><KeybindProvider><Chords /></KeybindProvider></AppSettingsProvider>);
    expect(JSON.parse((await screen.findByText(/Alt\+Shift\+D/)).textContent!)).toEqual({
      copy: [],
      paste: ["Mod+V"],
      duplicate: ["Alt+Shift+D"],
      delete: ["Delete", "Backspace"],
      toggleBreakpoint: ["F9"],
    });
  });
});

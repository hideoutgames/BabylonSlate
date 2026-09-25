import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { defaultEngineSettings, type EngineSettings } from "@babylonslate/vfs";
import { KeybindSettings } from "./keybind-settings";

afterEach(cleanup);

function Harness({
  initial = {},
  onKeybinds = () => {},
}: {
  initial?: EngineSettings["keybinds"];
  onKeybinds?: (keybinds: EngineSettings["keybinds"]) => void;
}) {
  const [settings, setSettings] = useState<EngineSettings>(() => ({
    ...defaultEngineSettings(),
    keybinds: initial,
  }));
  return (
    <KeybindSettings
      settings={settings}
      onChange={(patch) => {
        if (patch.keybinds) onKeybinds(patch.keybinds);
        setSettings((current) => ({ ...current, ...patch }));
      }}
    />
  );
}

describe("KeybindSettings", () => {
  it("records a pressed chord as the command's new shortcut", () => {
    const onKeybinds = vi.fn();
    const view = render(<Harness onKeybinds={onKeybinds} />);
    fireEvent.click(view.getByTestId("keybind-record-edit.rename"));
    expect(view.getByTestId("keybind-record-edit.rename").textContent).toContain("Press Keys");
    fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(window, { key: "R", code: "KeyR", shiftKey: true, ctrlKey: true });
    expect(onKeybinds).toHaveBeenLastCalledWith({ "edit.rename": ["Mod+Shift+R"] });
    expect(view.getByTestId("keybind-record-edit.rename").textContent).not.toContain("Press Keys");
    expect(view.getByTestId("keybind-reset-edit.rename")).toHaveProperty("disabled", false);
  });

  it("cancels recording on Escape without letting the dialog see it", () => {
    const onKeybinds = vi.fn();
    const dialogEscape = vi.fn();
    document.addEventListener("keydown", dialogEscape);
    const view = render(<Harness onKeybinds={onKeybinds} />);
    fireEvent.click(view.getByTestId("keybind-record-edit.rename"));
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    document.removeEventListener("keydown", dialogEscape);
    expect(onKeybinds).not.toHaveBeenCalled();
    expect(dialogEscape).not.toHaveBeenCalled();
    expect(view.getByTestId("keybind-record-edit.rename").textContent).not.toContain("Press Keys");
  });

  it("warns when a chord is shared with another command or the fly keys", () => {
    const view = render(
      <Harness initial={{ "edit.rename": ["Mod+Z"], "viewport.translate": ["W"] }} />,
    );
    expect(view.getByTestId("keybind-conflict-edit.rename").textContent).toContain("Undo");
    expect(view.getByTestId("keybind-conflict-editor.undo").textContent).toContain("Rename");
    expect(view.getByTestId("keybind-conflict-viewport.translate").textContent).toContain(
      "Viewport Fly",
    );
  });

  it("unassigns, resets one command, and resets everything", () => {
    const onKeybinds = vi.fn();
    const view = render(
      <Harness initial={{ "play.start": ["F5"] }} onKeybinds={onKeybinds} />,
    );
    fireEvent.click(view.getByTestId("keybind-clear-edit.delete"));
    expect(onKeybinds).toHaveBeenLastCalledWith({ "play.start": ["F5"], "edit.delete": [] });
    expect(view.getByTestId("keybind-record-edit.delete").textContent).toContain("Unassigned");

    fireEvent.click(view.getByTestId("keybind-reset-play.start"));
    expect(onKeybinds).toHaveBeenLastCalledWith({ "edit.delete": [] });

    fireEvent.click(view.getByTestId("keybinds-reset-all"));
    expect(onKeybinds).toHaveBeenLastCalledWith({});
    expect(view.getByTestId("keybinds-reset-all")).toHaveProperty("disabled", true);
  });
});

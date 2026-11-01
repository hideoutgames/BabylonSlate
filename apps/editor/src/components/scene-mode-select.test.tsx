import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeybindProvider } from "../context/keybind-context";
import { SceneModeSelect } from "./scene-mode-select";

const setSceneMode = vi.fn();
vi.mock("../context/document-context", () => ({
  useDocumentActions: () => ({ setSceneMode }),
  useActiveDocumentState: () => ({ sceneMode: "design", activeDocumentId: "scene-1" }),
}));

afterEach(() => {
  cleanup();
  setSceneMode.mockReset();
});

const shiftDigit = (digit: number) => ({ key: String(digit), code: `Digit${digit}`, shiftKey: true });

describe("SceneModeSelect", () => {
  it("switches the active Scene between Design, Landscape and Foliage with Shift+1, Shift+2 and Shift+3", () => {
    render(<KeybindProvider><SceneModeSelect /></KeybindProvider>);
    fireEvent.keyDown(document.body, shiftDigit(2));
    fireEvent.keyDown(document.body, shiftDigit(3));
    fireEvent.keyDown(document.body, shiftDigit(1));
    expect(setSceneMode.mock.calls).toEqual([
      ["scene-1", "landscape"],
      ["scene-1", "foliage"],
      ["scene-1", "design"],
    ]);
  });

  it("offers a Scene Layer only Design, Script and Timeline, with Shift+4 and Shift+5", () => {
    render(<KeybindProvider><SceneModeSelect kind="scene-layer" /></KeybindProvider>);
    fireEvent.keyDown(document.body, shiftDigit(2));
    fireEvent.keyDown(document.body, shiftDigit(4));
    fireEvent.keyDown(document.body, shiftDigit(5));
    expect(setSceneMode.mock.calls).toEqual([["scene-1", "script"], ["scene-1", "timeline"]]);
    fireEvent.click(screen.getByTestId("scene-mode-select"));
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-keyshortcuts"))).toEqual(["Shift+1", "Shift+4", "Shift+5"]);
    expect(screen.queryByRole("option", { name: /Landscape/ })).toBeNull();
  });

  it("ignores the mode shortcuts while the select is disabled for Play", () => {
    render(<KeybindProvider><SceneModeSelect disabled /></KeybindProvider>);
    fireEvent.keyDown(document.body, shiftDigit(2));
    expect(setSceneMode).not.toHaveBeenCalled();
  });

  it("shows each mode's shortcut in the dropdown", () => {
    render(<KeybindProvider><SceneModeSelect /></KeybindProvider>);
    fireEvent.click(screen.getByTestId("scene-mode-select"));
    const landscape = screen.getByRole("option", { name: /Landscape/ });
    expect(landscape.getAttribute("aria-keyshortcuts")).toBe("Shift+2");
    expect(landscape.querySelector("[data-slot=shortcut-keys]")).toBeTruthy();
  });
});

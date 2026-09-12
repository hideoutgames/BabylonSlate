import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  InputBindingsPanel,
  InputBindingDetailsPanel,
} from "./input-asset-panels";
import { InputAssetEditingProvider } from "../context/input-asset-editing-context";

const apply = vi.hoisted(() => vi.fn(async () => true));
const documentKind = vi.hoisted(() => ({ value: "input-action" }));
vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "jump" }),
}));
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    activeDocumentId: "jump",
    openDocuments: [
      {
        id: "jump",
        ref: { kind: documentKind.value, path: "Jump.inputaction.babasset" },
        content: {
          valueType: documentKind.value === "input-axis" ? "1d" : "button",
          bindings: [
            { id: "keyboard", device: "key", code: "Space" },
            { id: "pad", device: "gamepadButton", code: "0:0" },
          ],
        },
      },
    ],
    applyAssetDocumentChange: apply,
  }),
}));
afterEach(() => {
  cleanup();
  apply.mockClear();
  documentKind.value = "input-action";
});
const Editor = () => (
  <InputAssetEditingProvider>
    <InputBindingsPanel {...({} as IDockviewPanelProps)} />
    <InputBindingDetailsPanel {...({} as IDockviewPanelProps)} />
  </InputAssetEditingProvider>
);

describe("input asset editor", () => {
  it.each(["input-action", "input-axis"])(
    "adds mouse controls to %s through the unified authoring choices",
    (kind) => {
      documentKind.value = kind;
      render(<Editor />);
      fireEvent.click(screen.getByRole("button", { name: "Add Control" }));
      expect(screen.queryByTestId("search-item-pointer")).toBeNull();
      expect(screen.queryByTestId("search-item-touch")).toBeNull();
      fireEvent.click(screen.getByTestId("search-item-mouseButton"));
      expect(apply).toHaveBeenLastCalledWith(
        "jump",
        expect.objectContaining({
          bindings: [
            expect.objectContaining({ id: "keyboard" }),
            expect.objectContaining({ id: "pad" }),
            expect.objectContaining({ device: "mouseButton", code: "" }),
          ],
        }),
      );
    },
  );

  it.each(["input-action", "input-axis"])(
    "selects %s controls from the whole row or keyboard without trapping child controls",
    (kind) => {
      documentKind.value = kind;
      render(<Editor />);
      const keyboard = screen.getByRole("group", { name: "Control 1" });
      const gamepad = screen.getByRole("group", { name: "Control 2" });

      fireEvent.click(keyboard);
      expect(keyboard.getAttribute("aria-current")).toBe("true");
      expect(screen.getByText("Shift Required")).toBeTruthy();
      fireEvent.keyDown(gamepad, { key: "Enter" });
      expect(gamepad.getAttribute("aria-current")).toBe("true");
      expect(screen.queryByText("Shift Required")).toBeNull();
      fireEvent.keyDown(keyboard, { key: " " });
      expect(keyboard.getAttribute("aria-current")).toBe("true");

      const listen = screen.getByRole("button", { name: "Listen" });
      fireEvent.keyDown(gamepad, { key: "Enter" });
      fireEvent.keyDown(listen, { key: " " });
      expect(gamepad.getAttribute("aria-current")).toBe("true");
      fireEvent.click(listen);
      expect(
        screen.getByRole("button", { name: "Press a Key · Esc Cancels" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    },
  );

  it("removes a different control without selecting it and clears a removed selection", () => {
    render(<Editor />);
    const keyboard = screen.getByRole("group", { name: "Control 1" });
    fireEvent.click(keyboard);
    fireEvent.click(screen.getByRole("button", { name: "Remove Control 2" }));
    expect(keyboard.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Shift Required")).toBeTruthy();
    expect(apply).toHaveBeenLastCalledWith(
      "jump",
      expect.objectContaining({
        bindings: [expect.objectContaining({ id: "keyboard" })],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Control 1" }));
    expect(
      screen.getByText("Select a control in Bindings to edit its details."),
    ).toBeTruthy();
  });

  it("captures chords into the selected stable binding and leaves other controls unchanged", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    fireEvent.keyDown(window, { code: "KeyJ", key: "j", ctrlKey: true });
    expect(apply).toHaveBeenCalledWith(
      "jump",
      expect.objectContaining({
        bindings: [
          expect.objectContaining({
            id: "keyboard",
            code: "KeyJ",
            modifiers: expect.objectContaining({ ctrl: true }),
          }),
          expect.objectContaining({ id: "pad", code: "0:0" }),
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Listen" })).toBeTruthy();
  });
  it("cancels capture on escape or focus loss without writing and removes only the chosen control", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    fireEvent.keyDown(window, { code: "Escape" });
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    fireEvent.blur(window);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Control 1" }));
    expect(apply).toHaveBeenCalledWith(
      "jump",
      expect.objectContaining({
        bindings: [expect.objectContaining({ id: "pad" })],
      }),
    );
  });
});

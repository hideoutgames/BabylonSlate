import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  InputBindingsPanel,
  InputBindingDetailsPanel,
} from "./input-asset-panels";
import { InputAssetEditingProvider } from "../context/input-asset-editing-context";

const apply = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "jump" }),
}));
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    activeDocumentId: "jump",
    openDocuments: [
      {
        id: "jump",
        ref: { kind: "input-action", path: "Jump.inputaction.babasset" },
        content: {
          valueType: "button",
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
});
const Editor = () => (
  <InputAssetEditingProvider>
    <InputBindingsPanel {...({} as IDockviewPanelProps)} />
    <InputBindingDetailsPanel {...({} as IDockviewPanelProps)} />
  </InputAssetEditingProvider>
);

describe("input asset editor", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Remove control 1" }));
    expect(apply).toHaveBeenCalledWith(
      "jump",
      expect.objectContaining({
        bindings: [expect.objectContaining({ id: "pad" })],
      }),
    );
  });
});

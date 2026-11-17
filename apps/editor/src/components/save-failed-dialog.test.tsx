import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SaveFailed } from "../context/document-context-types";
import { SaveFailedDialog } from "./save-failed-dialog";

const state = vi.hoisted(() => ({
  saveFailed: null as import("../context/document-context-types").SaveFailed | null,
  dismissSaveFailed: vi.fn(),
  discardDocumentChanges: vi.fn<(paths: string[]) => Promise<boolean>>(async () => true),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    saveFailed: state.saveFailed,
    dismissSaveFailed: state.dismissSaveFailed,
    discardDocumentChanges: state.discardDocumentChanges,
  })),
);

const TWO_LOCKED: SaveFailed = {
  purpose: "save",
  documents: [
    { id: "scene:assets/Main.scene.hasset", path: "assets/Main.scene.hasset", label: "Main Scene", holder: "Bob" },
    { id: "graph:assets/Hero.class.hasset", path: "assets/Hero.class.hasset", label: "Hero Class", holder: "Ada" },
  ],
};

afterEach(() => {
  cleanup();
  state.saveFailed = null;
  state.dismissSaveFailed.mockClear();
  state.discardDocumentChanges.mockReset();
  state.discardDocumentChanges.mockResolvedValue(true);
});

describe("SaveFailedDialog", () => {
  it("shows nothing until a Save All leaves locked documents unsaved", () => {
    render(<SaveFailedDialog />);
    expect(screen.queryByTestId("save-failed-dialog")).toBeNull();
  });

  it("names each locked file with its holder in one prompt, and Ignore keeps their changes", () => {
    state.saveFailed = TWO_LOCKED;
    render(<SaveFailedDialog />);
    const dialog = screen.getByTestId("save-failed-dialog");
    expect(within(dialog).getByText("Save Failed")).toBeTruthy();
    expect(within(screen.getByTestId("save-failed-files")).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Main SceneLocked by Bob",
      "Hero ClassLocked by Ada",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Ignore" }));
    expect(state.dismissSaveFailed).toHaveBeenCalledOnce();
    expect(state.discardDocumentChanges).not.toHaveBeenCalled();
  });

  it("discards the changes of every listed file at once, then closes", async () => {
    state.saveFailed = TWO_LOCKED;
    render(<SaveFailedDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(state.discardDocumentChanges).toHaveBeenCalledWith(["assets/Main.scene.hasset", "assets/Hero.class.hasset"]);
    await waitFor(() => expect(state.dismissSaveFailed).toHaveBeenCalledOnce());
  });

  it("stays open and says so when the changes cannot be discarded now", async () => {
    state.saveFailed = TWO_LOCKED;
    state.discardDocumentChanges.mockResolvedValue(false);
    render(<SaveFailedDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect((await screen.findByTestId("save-failed-discard-error")).getAttribute("role")).toBe("alert");
    expect(state.dismissSaveFailed).not.toHaveBeenCalled();
    expect(screen.getByTestId("save-failed-dialog")).toBeTruthy();
  });

  it.each([
    ["play", "Play didn't start"],
    ["preview", "Preview Build plays saved files only"],
  ] as const)("says why %s did not start", (purpose, text) => {
    state.saveFailed = { ...TWO_LOCKED, purpose };
    render(<SaveFailedDialog />);
    expect(screen.getByTestId("save-failed-dialog").textContent).toContain(text);
  });
});

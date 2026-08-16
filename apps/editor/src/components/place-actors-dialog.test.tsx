import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlaceActorsDialog } from "./place-actors-dialog";

/**
 * The Outliner closes this dialog itself after spawning, so the close never
 * goes through the dialog's own `onOpenChange`. Reopening must still start
 * from an empty catalog.
 */
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <PlaceActorsDialog
        open={open}
        onOpenChange={setOpen}
        onSelect={() => setOpen(false)}
        projectItems={[]}
      />
    </>
  );
}

function searchValue(): string {
  return (screen.getByTestId("place-actors-catalog-search") as HTMLInputElement)
    .value;
}

afterEach(() => {
  cleanup();
});

describe("PlaceActorsDialog", () => {
  it("clears the search after the Outliner closes it on select", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("place-actors-catalog-search"), {
      target: { value: "sphere" },
    });
    expect(screen.queryByTestId("place-actors-item-shape-box")).toBeNull();

    fireEvent.click(screen.getByTestId("place-actors-item-shape-sphere"));
    fireEvent.click(screen.getByTestId("reopen"));

    expect(searchValue()).toBe("");
    expect(screen.getByTestId("place-actors-item-shape-box")).toBeTruthy();
  });

  it("clears the active category after the Outliner closes it on select", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("place-actors-catalog-category-Lights"));
    expect(screen.queryByTestId("place-actors-item-shape-box")).toBeNull();

    fireEvent.click(screen.getByTestId("place-actors-item-light-point"));
    fireEvent.click(screen.getByTestId("reopen"));

    expect(screen.getByTestId("place-actors-item-shape-box")).toBeTruthy();
  });

  it("still clears the search when dismissed without selecting", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("place-actors-catalog-search"), {
      target: { value: "sphere" },
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("reopen"));

    expect(searchValue()).toBe("");
  });
});

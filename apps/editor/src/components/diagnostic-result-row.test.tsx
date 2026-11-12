import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiagnosticResultRow } from "./diagnostic-result-row";

const writeText = vi.fn<(text: string) => Promise<void>>();
let clipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function renderRow(props: { onOpen?: () => void; details?: string } = {}) {
  const onSelect = vi.fn();
  render(
    <DiagnosticResultRow
      severity="error"
      message="Type mismatch: float is not assignable to bool"
      code="type.mismatch"
      location="branch.condition"
      onSelect={onSelect}
      testId="row"
      {...props}
    />,
  );
  return { onSelect, row: screen.getByTestId("row") };
}

function openMenu(row: HTMLElement) {
  fireEvent.contextMenu(row, { clientX: 20, clientY: 10 });
  return screen.getByTestId("diagnostic-row-menu");
}

describe("DiagnosticResultRow", () => {
  it("opens on a second click or tap within the double-tap window", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const { onSelect, row } = renderRow({ onOpen });
    fireEvent.click(row, { detail: 1 });
    expect([onSelect.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 0]);
    vi.advanceTimersByTime(100);
    fireEvent.click(row, { detail: 1 });
    expect([onSelect.mock.calls.length, onOpen.mock.calls.length]).toEqual([1, 1]);
    // A click after the window chooses again; a mouse double-click (detail 2) opens whatever its timing.
    vi.advanceTimersByTime(2000);
    fireEvent.click(row, { detail: 1 });
    vi.advanceTimersByTime(2000);
    fireEvent.click(row, { detail: 2 });
    expect([onSelect.mock.calls.length, onOpen.mock.calls.length]).toEqual([2, 2]);
  });

  it("chooses on every keyboard activation, and on a double-click without Open", () => {
    const onOpen = vi.fn();
    const { onSelect, row } = renderRow({ onOpen });
    fireEvent.click(row, { detail: 0 });
    fireEvent.click(row, { detail: 0 });
    expect([onSelect.mock.calls.length, onOpen.mock.calls.length]).toEqual([2, 0]);
    cleanup();

    const plain = renderRow();
    fireEvent.click(plain.row, { detail: 1 });
    fireEvent.click(plain.row, { detail: 2 });
    expect(plain.onSelect).toHaveBeenCalledTimes(2);
  });

  it("offers Open and copies the message or the details from its menu without choosing the row", async () => {
    const onOpen = vi.fn();
    const { onSelect, row } = renderRow({ onOpen, details: "error: type.mismatch\nfull details" });
    const menu = openMenu(row);
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(["Open", "Copy Error", "Copy Details"]);

    fireEvent.click(screen.getByTestId("diagnostic-menu-copy"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Type mismatch: float is not assignable to bool"));
    openMenu(row);
    fireEvent.click(screen.getByTestId("diagnostic-menu-copy-details"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("error: type.mismatch\nfull details"));
    openMenu(row);
    fireEvent.click(screen.getByTestId("diagnostic-menu-open"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("copies its own text when the host gives no details, and offers no Open without one", async () => {
    const { row } = renderRow();
    const menu = openMenu(row);
    expect(
      [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(["Copy Error", "Copy Details"]);
    fireEvent.click(screen.getByTestId("diagnostic-menu-copy-details"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(
      "error: type.mismatch\nType mismatch: float is not assignable to bool\nbranch.condition",
    ));
  });

  it("says so in the row when the clipboard refuses the copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn(() => false);
    const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      const { row } = renderRow();
      openMenu(row);
      fireEvent.click(screen.getByTestId("diagnostic-menu-copy"));
      expect(await screen.findByRole("status")).toHaveProperty("textContent", "Could not copy to the clipboard.");
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      if (previous) Object.defineProperty(document, "execCommand", previous);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });
});

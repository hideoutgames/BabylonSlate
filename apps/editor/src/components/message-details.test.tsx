import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageDetails } from "./message-details";

afterEach(cleanup);

describe("MessageDetails", () => {
  it("does not report an earlier copy as success for a newly selected message", async () => {
    let finishCopy!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => pending },
    });
    try {
      const { rerender } = render(
        <MessageDetails
          title="Diagnostic Details"
          message="Diagnostic A"
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      rerender(
        <MessageDetails
          title="Diagnostic Details"
          message="Diagnostic B"
          onClose={vi.fn()}
        />,
      );
      await act(async () => {
        finishCopy();
        await pending;
      });
      expect(screen.getByText("Diagnostic B")).toBeTruthy();
      expect(screen.queryByText("Copied")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

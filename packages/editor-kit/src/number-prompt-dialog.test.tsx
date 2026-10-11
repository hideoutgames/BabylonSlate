import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumberPromptDialog } from "./number-prompt-dialog";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

describe("NumberPromptDialog", () => {
  it("seeds the saved value and submits a changed number", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={onOpenChange}
        title="Grid Size"
        label="Grid Size"
        initialValue={1}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByTestId("number-prompt-input")).toHaveProperty(
      "value",
      "1",
    );
    fireEvent.change(screen.getByTestId("number-prompt-input"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("number-prompt-confirm"));
    expect(onSubmit).toHaveBeenCalledWith(4);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("submits an evaluated expression through its Enter shortcut", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={onOpenChange}
        title="Grid Size"
        label="Grid Size"
        initialValue={30}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByTestId("number-prompt-input");
    fireEvent.change(input, { target: { value: "30/2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(15);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("submits the saved value when Enter is pressed without editing", () => {
    const onSubmit = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={() => {}}
        title="Grid Size"
        label="Grid Size"
        initialValue={30}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.keyDown(screen.getByTestId("number-prompt-input"), {
      key: "Enter",
    });

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(30);
  });

  it.each(["Enter", "Save"] as const)(
    "submits the clamped expression result instead of stale state on %s",
    (route) => {
      const onSubmit = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <NumberPromptDialog
          open
          onOpenChange={onOpenChange}
          title="Grid Size"
          label="Grid Size"
          initialValue={16}
          min={10}
          onSubmit={onSubmit}
        />,
      );
      const input = screen.getByTestId("number-prompt-input");
      fireEvent.change(input, { target: { value: "30" } });
      fireEvent.change(input, { target: { value: "30/6" } });
      if (route === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(screen.getByTestId("number-prompt-confirm"));

      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(10);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("keeps the prompt open when Save finds an invalid expression", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={onOpenChange}
        title="Grid Size"
        label="Grid Size"
        initialValue={30}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("number-prompt-input");
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.change(input, { target: { value: "40/" } });
    fireEvent.click(screen.getByTestId("number-prompt-confirm"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/expression/i);
  });

  it.each(["30/", "30/0"])(
    "keeps the prompt open and explains invalid expression %s on Enter",
    (expression) => {
      const onSubmit = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <NumberPromptDialog
          open
          onOpenChange={onOpenChange}
          title="Grid Size"
          label="Grid Size"
          initialValue={30}
          onSubmit={onSubmit}
        />,
      );
      const input = screen.getByTestId("number-prompt-input");
      fireEvent.change(input, { target: { value: expression } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(input).toHaveProperty("value", "30");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toMatch(/expression/i);
      fireEvent.blur(input);
      expect(screen.getByRole("alert").textContent).toMatch(/expression/i);

      fireEvent.change(input, { target: { value: "30/2" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(15);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("does not submit when Enter confirms IME composition", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NumberPromptDialog
        open
        onOpenChange={onOpenChange}
        title="Grid Size"
        label="Grid Size"
        initialValue={30}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("number-prompt-input");
    fireEvent.change(input, { target: { value: "30/2" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input).toHaveProperty("value", "30/2");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

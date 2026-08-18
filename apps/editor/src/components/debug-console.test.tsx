import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createCommandRegistry } from "@babylonslate/debugger";
import { DebugConsole } from "./debug-console";

describe("DebugConsole", () => {
  afterEach(() => {
    cleanup();
  });

  it("runs a command, shows SelectableText output, and suggests names", async () => {
    const onExecute = vi.fn().mockResolvedValue({
      success: true,
      output: "changed scene to other-level",
    });
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry({ includeDebug: true }).list()}
        onExecute={onExecute}
      />,
    );

    const root = screen.getByTestId("debug-console");
    expect(root.getAttribute("data-slot")).toBe("dialog-content");
    expect(root.getAttribute("data-side")).toBeNull();

    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "ch" },
    });
    expect(screen.getByTestId("debug-console-suggest-changescene")).toBeTruthy();

    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "changescene other-level" },
    });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(onExecute).toHaveBeenCalledWith("changescene other-level");
    expect(await screen.findByText("changed scene to other-level")).toBeTruthy();
    expect(screen.getByTestId("debug-console-transcript").textContent).toContain(
      "> changescene other-level",
    );
  });

  it("opens as a large overlay instead of a small centered dialog", () => {
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry({ includeDebug: true }).list()}
        onExecute={async () => ({ success: true, output: "" })}
      />,
    );
    const root = screen.getByTestId("debug-console");
    expect(root.className).toContain("h-[min(92vh,56rem)]");
    expect(root.className).toContain("w-[min(96vw,80rem)]");
    expect(root.className).toContain("max-w-none");
    expect(root.className).not.toContain("sm:max-w-lg");
    const header = root.querySelector('[data-slot="dialog-header"]');
    expect(header?.className).toContain("flex-row");
    expect(header?.className).toContain("gap-2");
    expect(header?.className).not.toContain("space-y-");
    expect(screen.getByTestId("debug-console-input").hasAttribute("autofocus")).toBe(
      false,
    );
    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "ch" },
    });
    const suggest = screen.getByTestId("debug-console-suggest-changescene");
    expect(suggest.className).toContain("min-h-[var(--touch-target,44px)]");
    expect(screen.getByTestId("debug-console-clear")).toBeTruthy();
    expect(screen.getByTestId("debug-console-copy")).toBeTruthy();
  });

  it("clears the transcript and copies it to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onExecute = vi.fn().mockResolvedValue({
      success: false,
      output: "unknown command: nope",
    });
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry({ includeDebug: true }).list()}
        onExecute={onExecute}
      />,
    );

    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    const output = await screen.findByTestId("debug-console-output-0");
    expect(output.textContent).toContain("unknown command: nope");
    expect(output.className).toContain("text-destructive");

    fireEvent.click(screen.getByTestId("debug-console-copy"));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("> nope"),
    );
    expect(writeText.mock.calls[0]?.[0]).toContain("unknown command: nope");

    fireEvent.click(screen.getByTestId("debug-console-clear"));
    expect(screen.getByTestId("debug-console-transcript").textContent).toBe("");
  });
});

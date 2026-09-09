import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createCommandRegistry, createUserCommand } from "@babylonslate/debugger";
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
    expect(root.getAttribute("data-slot")).toBe("sheet-content");
    expect(root.getAttribute("data-side")).toBe("bottom");

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

  it("shows a scrollable context list and applies its keyboard selection", () => {
    const commands = Array.from({ length: 12 }, (_, index) => createUserCommand({
      name: `nav${String(index).padStart(2, "0")}`, description: `Navigation tool ${index}`,
      category: "debug", parameters: [], run: () => ({ success: true, output: "" }),
    }));
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={commands}
        onExecute={async () => ({ success: true, output: "" })}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Console command" });
    fireEvent.change(input, { target: { value: "nav" } });
    expect(screen.getAllByRole("option")).toHaveLength(12);
    expect(screen.getByRole("listbox").className).toContain("overflow-y-auto");
    expect(screen.getByRole("option", { name: /nav11/ }).textContent).toContain("Navigation tool 11");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /nav01/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Tab" });
    expect((input as HTMLInputElement).value).toBe("nav01 ");
  });

  it("applies a suggestion into the current token", async () => {
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry({ includeDebug: true }).list()}
        onExecute={async () => ({ success: true, output: "" })}
      />,
    );
    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "renderquality " },
    });
    fireEvent.click(screen.getByTestId("debug-console-suggest-high"));
    expect(
      (screen.getByTestId("debug-console-input") as HTMLInputElement).value,
    ).toBe("renderquality high");
  });

  it("retains command history and restores a draft after browsing history", async () => {
    render(<DebugConsole open onOpenChange={() => {}} commands={createCommandRegistry().list()} onExecute={async () => ({ success: true, output: "Ready" })} />);
    const input = screen.getByTestId("debug-console-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    await screen.findByText("Ready");
    fireEvent.change(input, { target: { value: "unsubmitted" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("help");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("unsubmitted");
  });

  it("shows play logs and prints, copies them, and only clears existing messages", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const props = { open: true, onOpenChange: () => {}, commands: createCommandRegistry().list(), onExecute: async () => ({ success: true, output: "" }) };
    const logs = [
      { id: 1, timestamp: 10, severity: "info", message: "Game started" },
      { id: 2, timestamp: 20, severity: "print", message: "Hello from actor" },
      { id: 3, timestamp: 30, severity: "warning", message: "Missing target" },
      { id: 4, timestamp: 40, severity: "error", message: "Script failed" },
    ];
    const view = render(<DebugConsole {...props} logs={logs} />);
    expect(screen.getByTestId("debug-console-transcript").textContent).toContain("Game started");
    expect(screen.getByTestId("debug-console-log-3").getAttribute("data-severity")).toBe("warning");
    expect(screen.getByTestId("debug-console-log-4").className).toContain("text-destructive");
    fireEvent.click(screen.getByTestId("debug-console-copy"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("[print] Hello from actor"));
    fireEvent.click(screen.getByTestId("debug-console-clear"));
    expect(screen.getByTestId("debug-console-transcript").textContent).toBe("");
    view.rerender(<DebugConsole {...props} logs={[...logs, { id: 5, timestamp: 50, severity: "info", message: "Next frame" }]} />);
    expect(screen.getByTestId("debug-console-transcript").textContent).toBe("[info] Next frame");
  });

  it("reports rejected execution without losing the command or blocking the next run", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("Worker disconnected")).mockResolvedValueOnce({ success: true, output: "Reconnected" });
    render(<DebugConsole open onOpenChange={() => {}} commands={createCommandRegistry().list()} onExecute={execute} />);
    const input = screen.getByTestId("debug-console-input");
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(await screen.findByText("Worker disconnected")).toBeTruthy();
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(await screen.findByText("Reconnected")).toBeTruthy();
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

  it("preserves newlines in command output", async () => {
    const onExecute = vi.fn().mockResolvedValue({
      success: true,
      output: "engine:\n  help — List commands or show usage for one name",
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
      target: { value: "help" },
    });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    const output = await screen.findByTestId("debug-console-output-0");
    expect(output.className).toContain("whitespace-pre-wrap");
    expect(output.textContent).toContain("engine:");
    expect(output.textContent).toContain(
      "help — List commands or show usage for one name",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createCommandRegistry,
  createUserCommand,
} from "@babylonslate/debugger";
import { DebugConsole } from "./debug-console";

describe("DebugConsole", () => {
  afterEach(() => {
    cleanup();
  });

  it("closes with Escape from the command input", () => {
    const onOpenChange = vi.fn();
    render(
      <DebugConsole
        open
        onOpenChange={onOpenChange}
        commands={createCommandRegistry().list()}
        onExecute={() => ({ success: true, output: "" })}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("debug-console-input"), {
      key: "Escape",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it.each([
    ["a mouse or keyboard environment", false, "debug-console-input"],
    ["a touch environment", true, "debug-console-transcript"],
  ] as const)("starts focused for %s so typing is not lost and the on-screen keyboard stays down", async (_label, coarse, focused) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query === "(pointer: coarse)", media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    try {
      render(
        <DebugConsole
          open
          onOpenChange={() => {}}
          commands={createCommandRegistry().list()}
          onExecute={() => ({ success: true, output: "" })}
        />,
      );
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(focused)));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays open while the game is pressed, and still closes from Escape and the close button", () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <canvas data-testid="game" tabIndex={0} />
        <DebugConsole
          open
          onOpenChange={onOpenChange}
          commands={createCommandRegistry().list()}
          onExecute={() => ({ success: true, output: "" })}
        />
      </>,
    );
    const game = screen.getByTestId("game");
    fireEvent.pointerDown(game);
    fireEvent.mouseDown(game);
    fireEvent.pointerUp(game);
    fireEvent.mouseUp(game);
    fireEvent.click(game);
    act(() => game.focus());
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("says why Enter does nothing while a command is still running, and keeps the typed line", async () => {
    let finish!: (result: { success: boolean; output: string }) => void;
    const onExecute = vi.fn(() => new Promise<{ success: boolean; output: string }>((resolve) => { finish = resolve; }));
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry().list()}
        onExecute={onExecute}
      />,
    );
    const input = screen.getByTestId("debug-console-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "changescene slow" } });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(screen.getByTestId("debug-console-submit").textContent).toBe("Running");
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByTestId("debug-console-busy")).toHaveLength(1);
    expect(screen.getByTestId("debug-console-busy").textContent).toContain("still running");
    expect(input.value).toBe("help");
    expect(onExecute).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ success: true, output: "done" }); });
    expect(screen.getByTestId("debug-console-submit").textContent).toBe("Run");
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(onExecute).toHaveBeenLastCalledWith("help");
  });

  it("draws a block caret that follows the typed text instead of key hints", () => {
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry().list()}
        onExecute={() => ({ success: true, output: "" })}
      />,
    );
    const input = screen.getByTestId("debug-console-input") as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBeNull();
    expect(screen.queryByTestId("debug-console-caret")).toBeNull();
    input.focus();
    fireEvent.change(input, { target: { value: "fps" } });
    const before = () => screen.getByTestId("debug-console-caret").previousSibling?.textContent;
    expect(before()).toBe("fps");
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    expect(before()).toBe("f");
    // A selected range shows the native highlight, not the block.
    input.setSelectionRange(0, 2);
    fireEvent.select(input);
    expect(screen.queryByTestId("debug-console-caret")).toBeNull();
    input.setSelectionRange(3, 3);
    fireEvent.select(input);
    fireEvent.blur(input);
    expect(screen.queryByTestId("debug-console-caret")).toBeNull();
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
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();

    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "ch" },
    });
    expect(
      screen.getByTestId("debug-console-suggest-changescene"),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "changescene other-level" },
    });
    fireEvent.click(screen.getByTestId("debug-console-submit"));
    expect(onExecute).toHaveBeenCalledWith("changescene other-level");
    expect(
      await screen.findByText("changed scene to other-level"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("debug-console-transcript").textContent,
    ).toContain("> changescene other-level");
  });

  it("shows a scrollable context list and applies its keyboard selection", () => {
    const commands = Array.from({ length: 12 }, (_, index) =>
      createUserCommand({
        name: `nav${String(index).padStart(2, "0")}`,
        description: `Navigation tool ${index}`,
        category: "debug",
        parameters: [],
        run: () => ({ success: true, output: "" }),
      }),
    );
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
    expect(screen.getByRole("option", { name: /nav11/ }).textContent).toContain(
      "Navigation tool 11",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen
        .getByRole("option", { name: /nav01/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
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
      target: { value: "quality resolution " },
    });
    fireEvent.click(screen.getByTestId("debug-console-suggest-high"));
    expect(
      (screen.getByTestId("debug-console-input") as HTMLInputElement).value,
    ).toBe("quality resolution high");
  });

  it("stops following new output after the user scrolls back", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const props = {
        open: true,
        onOpenChange: () => {},
        commands: createCommandRegistry().list(),
        onExecute: () => ({ success: true, output: "" }),
      };
      const line = (id: number) => ({ id, timestamp: id, severity: "log", message: `Line ${id}` });
      const view = render(<DebugConsole {...props} logs={[line(1)]} />);
      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 200 },
        scrollTop: { configurable: true, value: 0 },
      });
      fireEvent.scroll(viewport);
      scrollIntoView.mockClear();
      view.rerender(<DebugConsole {...props} logs={[line(1), line(2)]} />);
      expect(screen.getByTestId("debug-console-transcript").textContent).toContain("Line 2");
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not reset suggestion scrolling when live context refreshes", () => {
    const props = {
      open: true,
      onOpenChange: () => {},
      commands: createCommandRegistry().list(),
      onExecute: () => ({ success: true, output: "" }),
    };
    const view = render(
      <DebugConsole
        {...props}
        completionContext={{ scenes: ["North", "South"] }}
      />,
    );
    fireEvent.change(screen.getByTestId("debug-console-input"), {
      target: { value: "changescene " },
    });
    const scrollIntoView = vi.fn();
    const activeOption = screen.getByRole("option", { selected: true });
    Object.assign(activeOption, { scrollIntoView });
    view.rerender(
      <DebugConsole
        {...props}
        completionContext={{ scenes: ["North", "South"] }}
      />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("retains command history and restores a draft after browsing history", async () => {
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry().list()}
        onExecute={async () => ({ success: true, output: "Ready" })}
      />,
    );
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
    const props = {
      open: true,
      onOpenChange: () => {},
      commands: createCommandRegistry().list(),
      onExecute: async () => ({ success: true, output: "" }),
    };
    const logs = [
      { id: 1, timestamp: 10, severity: "info", message: "Game started" },
      { id: 2, timestamp: 20, severity: "print", message: "Hello from actor" },
      { id: 3, timestamp: 30, severity: "warning", message: "Missing target" },
      { id: 4, timestamp: 40, severity: "error", message: "Script failed" },
    ];
    const view = render(<DebugConsole {...props} logs={logs} />);
    expect(
      screen.getByTestId("debug-console-transcript").textContent,
    ).toContain("Game started");
    expect(
      screen.getByTestId("debug-console-log-3").getAttribute("data-severity"),
    ).toBe("warning");
    expect(screen.getByTestId("debug-console-log-4").className).toContain(
      "text-destructive",
    );
    fireEvent.click(screen.getByTestId("debug-console-copy"));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("[print] Hello from actor"),
    );
    fireEvent.click(screen.getByTestId("debug-console-clear"));
    expect(screen.getByTestId("debug-console-transcript").textContent).toBe("");
    view.rerender(
      <DebugConsole
        {...props}
        logs={[
          ...logs,
          { id: 5, timestamp: 50, severity: "info", message: "Next frame" },
        ]}
      />,
    );
    expect(screen.getByTestId("debug-console-transcript").textContent).toBe(
      "[info] Next frame",
    );
  });

  it("places command output among play logs by time, ahead of logs from the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20);
    try {
      render(
        <DebugConsole
          open
          onOpenChange={() => {}}
          commands={createCommandRegistry().list()}
          logs={[
            { id: 1, timestamp: 10, severity: "info", message: "Before" },
            { id: 2, timestamp: 20, severity: "info", message: "Same time" },
            { id: 3, timestamp: 30, severity: "info", message: "After" },
          ]}
          onExecute={async () => ({ success: true, output: "Ran" })}
        />,
      );
      fireEvent.change(screen.getByTestId("debug-console-input"), {
        target: { value: "help" },
      });
      fireEvent.click(screen.getByTestId("debug-console-submit"));
      await screen.findByText("Ran");
      const rows = Array.from(
        screen.getByTestId("debug-console-transcript").children,
        (row) => row.textContent,
      ).filter(Boolean);
      expect(rows).toEqual([
        "[info] Before",
        "> help",
        "Ran",
        "[info] Same time",
        "[info] After",
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("reports rejected execution without losing the command or blocking the next run", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("Worker disconnected"))
      .mockResolvedValueOnce({ success: true, output: "Reconnected" });
    render(
      <DebugConsole
        open
        onOpenChange={() => {}}
        commands={createCommandRegistry().list()}
        onExecute={execute}
      />,
    );
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
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("> nope"));
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

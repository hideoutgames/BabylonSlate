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
});

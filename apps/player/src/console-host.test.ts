import { describe, expect, it, vi } from "vitest";
import { createPlayerConsoleHost } from "./console-host";

describe("player console host", () => {
  it("coalesces live inspection separately from command responses and settles on stop", async () => {
    const controls: unknown[] = [];
    const host = createPlayerConsoleHost({
      execute: () => undefined,
      post: (control) => controls.push(control),
    });
    const first = host.inspectWorld();
    const repeated = host.inspectWorld();
    const command = host.execute("pause");
    expect(controls).toEqual([
      { type: "inspect" },
      { type: "console", line: "pause" },
    ]);
    host.receive({ type: "consoleResult", success: true, output: "Paused" });
    host.receive({
      type: "inspectSnapshot",
      snapshot: { tickIndex: 42, nodes: [] },
    });
    expect(await first).toEqual({ tickIndex: 42, nodes: [] });
    expect(await repeated).toEqual({ tickIndex: 42, nodes: [] });
    expect((await command).output).toBe("Paused");
    const pending = host.inspectWorld();
    host.dispose();
    expect(await pending).toEqual({ tickIndex: 0, nodes: [] });
    expect(await host.inspectWorld()).toEqual({ tickIndex: 0, nodes: [] });
    expect(controls).toHaveLength(3);
  });

  it("inspects directly in the in-process player", async () => {
    const host = createPlayerConsoleHost({
      execute: () => undefined,
      inspect: () => () => ({ tickIndex: 9, nodes: [] }),
      post: () => {
        throw new Error("Should use the runtime");
      },
    });
    expect(await host.inspectWorld()).toEqual({ tickIndex: 9, nodes: [] });
  });

  it("executes commands through the runtime and keeps worker responses paired with requests", async () => {
    const controls: unknown[] = [];
    let execute:
      ((line: string) => { success: boolean; output: string }) | undefined = undefined;
    const host = createPlayerConsoleHost({
      execute: () => execute,
      post: (control) => controls.push(control),
    });
    const first = host.execute("pause");
    const second = host.execute("step");
    expect(controls).toEqual([
      { type: "console", line: "pause" },
      { type: "console", line: "step" },
    ]);
    host.receive({ type: "consoleResult", success: true, output: "paused" });
    host.receive({ type: "consoleResult", success: true, output: "step" });
    expect(await first).toEqual({ success: true, output: "paused" });
    expect(await second).toEqual({ success: true, output: "step" });
    execute = vi.fn(() => ({ success: true, output: "resumed" }));
    expect(await host.execute("resume")).toEqual({
      success: true,
      output: "resumed",
    });
    expect(execute).toHaveBeenCalledWith("resume");
  });

  it("settles pending commands when playback stops and prevents later execution", async () => {
    const post = vi.fn();
    const host = createPlayerConsoleHost({ execute: () => undefined, post });
    const pending = host.execute("help");
    host.dispose();
    expect(await pending).toEqual({
      success: false,
      output: "Play session stopped",
    });
    expect((await host.execute("resume")).success).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

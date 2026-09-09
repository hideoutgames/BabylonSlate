import { describe, expect, it, vi } from "vitest";
import { createPlayerConsoleHost } from "./console-host";

describe("player console host", () => {
  it("executes commands through the runtime and keeps worker responses paired with requests", async () => {
    const controls: unknown[] = [];
    let execute: ((line: string) => { success: boolean; output: string }) | undefined;
    const host = createPlayerConsoleHost({ execute: () => execute, post: (control) => controls.push(control) });
    const first = host.execute("pause");
    const second = host.execute("step");
    expect(controls).toEqual([{ type: "console", line: "pause" }, { type: "console", line: "step" }]);
    host.receive({ type: "consoleResult", success: true, output: "paused" });
    host.receive({ type: "consoleResult", success: true, output: "step" });
    expect(await first).toEqual({ success: true, output: "paused" });
    expect(await second).toEqual({ success: true, output: "step" });
    execute = vi.fn(() => ({ success: true, output: "resumed" }));
    expect(await host.execute("resume")).toEqual({ success: true, output: "resumed" });
    expect(execute).toHaveBeenCalledWith("resume");
  });

  it("settles pending commands when playback stops and prevents later execution", async () => {
    const post = vi.fn();
    const host = createPlayerConsoleHost({ execute: () => undefined, post });
    const pending = host.execute("help");
    host.dispose();
    expect(await pending).toEqual({ success: false, output: "Play session stopped" });
    expect((await host.execute("resume")).success).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

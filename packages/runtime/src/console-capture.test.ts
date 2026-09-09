import { describe, expect, it } from "vitest";
import * as runtime from "./index";

describe("captureConsoleLogs", () => {
  it("includes captured native warnings in dumplog with one live log event", () => {
    const messages: unknown[] = [];
    const session = runtime.createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      onCommand: (command) => { if (command.type === "log") messages.push(command); },
    });
    const target: Pick<Console, "log" | "info" | "debug" | "warn" | "error"> = {
      log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
    };
    const stop = runtime.captureConsoleLogs(target, (message, severity) => session.reportLog?.(message, severity));
    target.warn("native warning", { count: 2 });
    expect(session.executeConsoleCommand("dumplog").output).toContain('native warning {"count":2}');
    expect(messages).toEqual([expect.objectContaining({ severity: "warning", message: 'native warning {"count":2}' })]);
    stop();
    session.stop();
  });

  it("forwards raw console levels and objects, then restores the host console", () => {
    const native: unknown[][] = [];
    const write = (...args: unknown[]) => { native.push(args); };
    const target = { log: write, info: write, debug: write, warn: write, error: write };
    const entries: Array<{ message: string; severity: string }> = [];
    const stop = runtime.captureConsoleLogs?.(target, (message, severity) => entries.push({ message, severity }));
    target.log("hello", { answer: 42 });
    target.warn("watch out");
    target.error(new Error("broken"));
    target.debug("detail");
    expect(entries).toEqual([
      { message: 'hello {"answer":42}', severity: "log" },
      { message: "watch out", severity: "warning" },
      { message: expect.stringContaining("Error: broken"), severity: "error" },
      { message: "detail", severity: "verbose" },
    ]);
    expect(native).toHaveLength(4);
    stop?.();
    target.info("after stop");
    expect(entries).toHaveLength(4);
    expect(target.log).toBe(write);
  });

  it("does not recurse when its receiver logs and tolerates circular values", () => {
    const target: Pick<Console, "log" | "info" | "debug" | "warn" | "error"> = {
      log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
    };
    const messages: string[] = [];
    const stop = runtime.captureConsoleLogs?.(target, (message) => {
      messages.push(message);
      target.log("receiver diagnostic");
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    target.log(circular, 5n, undefined);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("5");
    stop?.();
  });
});

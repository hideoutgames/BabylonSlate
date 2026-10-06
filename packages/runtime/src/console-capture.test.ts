import { describe, expect, it } from "vitest";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
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

  it("includes Print String output in dumplog and reports an unknown changescene", async () => {
    const registry = createDefaultNodeRegistry();
    const printPins = registry.get("debug.printString")!.pins({});
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        { id: "entry", typeId: "flow.event.beginPlay", position: { x: 0, y: 0 }, pins: registry.get("flow.event.beginPlay")!.pins({}), properties: {} },
        {
          id: "print",
          typeId: "debug.printString",
          position: { x: 0, y: 0 },
          pins: printPins.map((pin) => (pin.id === "inString" ? { ...pin, defaultValue: "hello from print" } : pin)),
          properties: {},
        },
      ],
      edges: [{ id: "e", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "print", targetPinId: "execIn" }],
    };
    const compiled = compileGraph(graph, { assetGuid: "printer", registry });
    const session = runtime.createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
    await session.loadScripts([{ assetGuid: "printer", classId: "Printer", source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
    session.spawnScriptedActor({ classId: "Printer" });
    expect(session.executeConsoleCommand("dumplog").output).toContain("hello from print");
    expect(session.executeConsoleCommand("changescene bogus")).toEqual({ success: false, output: "unknown scene: bogus" });
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

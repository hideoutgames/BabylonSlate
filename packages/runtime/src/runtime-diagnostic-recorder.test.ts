import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

afterEach(() => vi.useRealTimers());
function fixture(mode: "play" | "simulate" = "play") {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    sessionGeneration: 3, sessionMode: mode, playScene: createDefaultScene(), onCommand: command => commands.push(command) });
  runtime.realizePlayWorld(); runtime.start();
  let requestId = 0;
  const operation = (action: "start" | "stop", kind: "profile" | "frame" = "profile", byteBudget?: number) => runtime.requestDiagnosticOperation({
    sessionGeneration: 3, requestId: ++requestId, operation: { kind, action, recordingId: "recording", durationMs: 1000, byteBudget } });
  return { runtime, commands, operation };
}
describe("runtime explicit diagnostics", () => {
  it("collects per-tick streams only during a profile and flushes before stop acknowledgment", async () => {
    const { runtime, commands, operation } = fixture();
    try {
      runtime.tick(); expect(commands.some(command => command.type === "performanceTicks")).toBe(false);
      expect((await operation("start")).success).toBe(true);
      expect(runtime.executeConsoleCommand("snapshot start").success).toBe(false);
      runtime.tick(); runtime.tick();
      expect((await operation("stop")).success).toBe(true);
      const chunks = commands.filter(command => command.type === "performanceTicks");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ sequence: 0, droppedRecords: 0, recordingId: "recording" });
      const rows = chunks[0]!.rows;
      expect(rows.length).toBe(12); expect(rows[0]).toBe(2); expect(rows[6]).toBe(3);
      expect([...rows].every(value => Number.isFinite(value) && value >= 0)).toBe(true);
      runtime.tick(); expect(commands.filter(command => command.type === "performanceTicks")).toHaveLength(1);
    } finally { runtime.stop(); }
  });
  it("composes exclusive trace/frame/profile ownership and refuses Simulation dispatch", async () => {
    const { runtime, operation } = fixture();
    try {
      expect(runtime.executeConsoleCommand("snapshot start").success).toBe(true);
      expect((await operation("start")).success).toBe(false);
      runtime.executeConsoleCommand("snapshot stop");
      expect((await operation("start", "frame")).success).toBe(true);
      expect((await operation("start")).success).toBe(false);
      expect(runtime.executeConsoleCommand("snapshot start").success).toBe(false);
      await operation("stop", "frame");
      expect(runtime.executeConsoleCommand("snapshot start").success).toBe(true);
    } finally { runtime.stop(); }
    const simulation = fixture("simulate");
    try { expect((await simulation.operation("start")).success).toBe(false); }
    finally { simulation.runtime.stop(); }
  });
  it("ends on duration even while paused and bounds numeric retention before overflow", async () => {
    vi.useFakeTimers();
    const first = fixture();
    try {
      await first.operation("start"); first.runtime.pause(); await vi.advanceTimersByTimeAsync(1000);
      expect(first.commands).toContainEqual(expect.objectContaining({ type: "diagnosticOperationStopped", reason: "duration" }));
      expect(first.runtime.executeConsoleCommand("snapshot start").success).toBe(true);
    } finally { first.runtime.stop(); }
    const next = fixture();
    try {
      await next.operation("start", "profile", 48); next.runtime.tick(); next.runtime.tick(); await Promise.resolve();
      expect(next.commands).toContainEqual(expect.objectContaining({ type: "diagnosticOperationStopped", reason: "budget" }));
      const chunks = next.commands.filter(command => command.type === "performanceTicks");
      expect(chunks.reduce((bytes, chunk) => bytes + chunk.rows.byteLength, 0)).toBe(48);
      expect(chunks[0]!.droppedRecords).toBe(1);
    } finally { next.runtime.stop(); }
  });
});

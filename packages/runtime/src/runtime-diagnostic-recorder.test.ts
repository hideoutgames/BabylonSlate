import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, identitySerializedTransform } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { PERFORMANCE_SCRIPT_COLUMNS, PERFORMANCE_TICK_COLUMNS, PERFORMANCE_TICK_PHASE_COLUMNS } from "@haptic/debugger";
import { compileGraph, type GraphNode } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const WIDTH = PERFORMANCE_TICK_COLUMNS.length;
const at = (column: (typeof PERFORMANCE_TICK_COLUMNS)[number]) => PERFORMANCE_TICK_COLUMNS.indexOf(column);

afterEach(() => vi.useRealTimers());

const registry = createDefaultNodeRegistry();
const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
  ({ id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties });
/** A Door Class whose Event Tick runs a line of JavaScript, compiled without any debugging probes. */
function doorScript(): CompiledScript {
  const compiled = compileGraph({ id: "event-graph", kind: "event", nodes: [
    node("tick", "flow.event.tick"),
    node("js", "debug.executeJavaScript", { inputs: [], outputs: [], body: "let total = 0; for (let i = 0; i < 10; i++) total += i;" }),
  ], edges: [{ id: "exec", sourceNodeId: "tick", sourcePinId: "execOut", targetNodeId: "js", targetPinId: "execIn" }] },
  { assetGuid: "Door.class", registry });
  return { assetGuid: "Door.class", classId: "Door", className: "Door", source: compiled.source, anchors: compiled.anchors,
    entryPoints: compiled.entryPoints.map((point) => ({ ...point, title: "Event Tick" })) };
}
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
      expect(rows.length).toBe(2 * WIDTH); expect(rows[0]).toBe(2); expect(rows[WIDTH]).toBe(3);
      expect([...rows].every(value => Number.isFinite(value) && value >= 0)).toBe(true);
      // Script is every timed phase but physics.
      for (let row = 0; row < rows.length; row += WIDTH) {
        const phases = PERFORMANCE_TICK_PHASE_COLUMNS.reduce((sum, column) => sum + rows[row + at(column)]!, 0);
        expect(rows[row + at("scriptMs")]).toBeCloseTo(phases, 9);
      }
      runtime.tick(); expect(commands.filter(command => command.type === "performanceTicks")).toHaveLength(1);
    } finally { runtime.stop(); }
  });
  it("times each script entry point per tick while a profile records, naming each entry once", async () => {
    const commands: CommandMessage[] = [];
    const scene = createDefaultScene();
    scene.actors = ["front", "back"].map((id) => createActor(id, id, { classId: "Door", transform: identitySerializedTransform() }));
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      sessionGeneration: 3, sessionMode: "play", playScene: scene, onCommand: command => commands.push(command) });
    await runtime.loadScripts([doorScript()]);
    runtime.realizePlayWorld(); runtime.start();
    try {
      let requestId = 0;
      const operation = (action: "start" | "stop") => runtime.requestDiagnosticOperation({
        sessionGeneration: 3, requestId: ++requestId, operation: { kind: "profile", action, recordingId: "recording", durationMs: 1000 } });
      runtime.tick();
      expect((await operation("start")).success).toBe(true);
      runtime.tick(); runtime.tick();
      expect((await operation("stop")).success).toBe(true);
      runtime.tick();
      const chunks = commands.flatMap(command => command.type === "performanceTicks" ? [command] : []);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.scriptEntries).toEqual([{ assetGuid: "Door.class", classId: "Door", className: "Door",
        exportName: "onTick", event: "onTick", title: "Event Tick", graphId: "event-graph", nodeId: "tick" }]);
      const width = PERFORMANCE_SCRIPT_COLUMNS.length;
      const rows = chunks[0]!.scripts!;
      // One row per recorded tick, after its tick row: both Doors ran Event Tick once.
      expect(rows.length).toBe(2 * width);
      expect([rows[0], rows[1], rows[2], rows[width], rows[width + 1], rows[width + 2]]).toEqual([2, 0, 2, 3, 0, 2]);
      expect([chunks[0]!.rows[0], chunks[0]!.rows[PERFORMANCE_TICK_COLUMNS.length]]).toEqual([2, 3]);
      expect(rows[3]).toBeGreaterThanOrEqual(0);
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
      await next.operation("start", "profile", WIDTH * 8); next.runtime.tick(); next.runtime.tick(); await Promise.resolve();
      expect(next.commands).toContainEqual(expect.objectContaining({ type: "diagnosticOperationStopped", reason: "budget" }));
      const chunks = next.commands.filter(command => command.type === "performanceTicks");
      expect(chunks.reduce((bytes, chunk) => bytes + chunk.rows.byteLength, 0)).toBe(WIDTH * 8);
      expect(chunks[0]!.droppedRecords).toBe(1);
    } finally { next.runtime.stop(); }
  });
});

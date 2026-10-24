import { describe, expect, it } from "vitest";
import { PerformanceRecorder, type PerformanceScriptEntry } from "@haptic/debugger";
import { scriptCosts } from "./script-cost-model";

const DOOR_TICK: PerformanceScriptEntry = { assetGuid: "Door.class", classId: "Door", className: "Front Door", exportName: "onTick",
  event: "onTick", title: "Event Tick", graphId: "event-graph", nodeId: "tick" };
const DOOR_OPEN: PerformanceScriptEntry = { assetGuid: "Door.class", classId: "Door", className: "Front Door", exportName: "Open_Wide" };
const HERO_BEGIN: PerformanceScriptEntry = { assetGuid: "Hero.class", classId: "hero_pawn", exportName: "onBeginPlay", event: "onBeginPlay" };
const NEVER_RAN: PerformanceScriptEntry = { assetGuid: "Idle.class", classId: "Idle", exportName: "onTick", event: "onTick" };

/** Two ticks: Door's Event Tick and Open in the first, Event Tick alone in the second; Hero begins play in the first. */
function recording() {
  const recorder = new PerformanceRecorder({ now: () => 0 });
  recorder.start({ sessionId: "session", mode: "play", sourceSha: null, buildId: null, sceneId: "scene", backend: "webgl2",
    renderPath: "frameGraph", runtimeHost: "worker", quality: "low", frameCap: 60, dynamicResolution: false, enabledDiagnostics: [], gpuTiming: "unavailable" });
  for (const tickId of [1, 2]) recorder.recordTick({ tickId, elapsedMs: tickId * 16, scriptMs: 4, physicsMs: 0, publishMs: 0, otherMs: 0,
    gameInstanceMs: 0, sceneSubsystemsMs: 0, actorsMs: 4, componentsMs: 0, postPhysicsMs: 0, sceneSystemsMs: 0 });
  recorder.recordScriptEntries([DOOR_TICK, DOOR_OPEN, HERO_BEGIN, NEVER_RAN]);
  for (const [tickId, entry, calls, totalMs] of [[1, 0, 2, 1], [1, 1, 2, 3], [1, 2, 1, 0.5], [2, 0, 2, 2.5]] as const)
    recorder.recordScript({ tickId, entry, calls, totalMs });
  return recorder.stop()!;
}

describe("scriptCosts", () => {
  it("totals each Class and its entries over the recording, slowest first, with each one's worst tick", () => {
    const [door, hero, ...rest] = scriptCosts(recording());
    expect(rest).toEqual([]);
    expect(door).toMatchObject({ label: "Front Door", calls: 6, totalMs: 6.5, perTickMs: 3.25, worstTickMs: 4 });
    expect(door!.entries.map(({ label, calls, totalMs, perTickMs, worstTickMs }) => ({ label, calls, totalMs, perTickMs, worstTickMs }))).toEqual([
      { label: "Event Tick", calls: 4, totalMs: 3.5, perTickMs: 1.75, worstTickMs: 2.5 },
      { label: "Open Wide", calls: 2, totalMs: 3, perTickMs: 1.5, worstTickMs: 3 },
    ]);
    // Names recorded without a Class or canvas title read as the graph would show them.
    expect(hero).toMatchObject({ label: "Hero Pawn", totalMs: 0.5 });
    expect(hero!.entries[0]!.label).toBe("Event Begin Play");
  });
});

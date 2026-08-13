import { describe, expect, it } from "vitest";
import {
  clipForState,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  parseAnimGraphDocument,
  validateAnimGraph,
  animGraphToSerialized,
  serializedToAnimGraph,
  hydrateAnimGraphForEditor,
} from "./index";

describe("anim graph evaluator", () => {
  it("stays on the looping entry clip and wraps time", () => {
    const doc = createDefaultAnimGraph();
    const a = evaluateAnimGraph(doc, null, 0.5, { conditions: {} });
    expect(a.stateId).toBe("idle");
    expect(a.normalisedTime).toBeCloseTo(0.5, 5);
    const b = evaluateAnimGraph(doc, a, 0.75, { conditions: {} });
    expect(b.normalisedTime).toBeCloseTo(0.25, 5);
    expect(b.blendWeights.idle).toBe(1);
  });

  it("transitions when a condition is true", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.parameters = ["moving"];
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.1,
      hasExitTime: false,
      exitTime: 0,
    });
    const next = evaluateAnimGraph(doc, null, 0.016, {
      conditions: { moving: true },
    });
    expect(next.stateId).toBe("run");
    expect(next.normalisedTime).toBe(0);
  });

  it("rejects a missing entry state", () => {
    const doc = createDefaultAnimGraph();
    doc.entryStateId = "missing";
    expect(validateAnimGraph(doc).some((row) => row.code === "anim.missingEntry")).toBe(
      true,
    );
  });

  it("round-trips through the graph-ui serialized shape", () => {
    const doc = createDefaultAnimGraph();
    const next = serializedToAnimGraph(animGraphToSerialized(doc), doc);
    expect(next.entryStateId).toBe(doc.entryStateId);
    expect(next.states).toHaveLength(1);
  });

  it("rejects a missing clip and a dangling transition", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.clipId = "missing-clip";
    doc.transitions.push({
      id: "bad",
      fromStateId: "idle",
      toStateId: "gone",
      blendSeconds: 0,
      hasExitTime: false,
      exitTime: 0,
    });
    const codes = validateAnimGraph(doc).map((row) => row.code);
    expect(codes).toContain("anim.missingClip");
    expect(codes).toContain("anim.badTransition");
  });

  it("clamps a non-looping clip at the end", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.loop = false;
    const next = evaluateAnimGraph(doc, null, 2, { conditions: {} });
    expect(next.normalisedTime).toBe(1);
  });

  it("round-trips a document-chunk payload and resolves the state clip", () => {
    const doc = createDefaultAnimGraph("Hero");
    const parsed = parseAnimGraphDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
    expect(parseAnimGraphDocument({ name: "bad" })).toBeNull();
    expect(clipForState(doc, "idle")?.clipName).toBe("Idle");
  });

  it("hydrates state pins so Add Node is not an empty box", () => {
    const hydrated = hydrateAnimGraphForEditor(
      animGraphToSerialized(createDefaultAnimGraph()),
    );
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
    }>;
    expect(pins.some((pin) => pin.id === "in" && pin.direction === "in")).toBe(
      true,
    );
    expect(pins.some((pin) => pin.id === "out" && pin.direction === "out")).toBe(
      true,
    );
  });

  it("round-trips dragged node positions through the graph-ui serialized shape", () => {
    const doc = createDefaultAnimGraph();
    const serialized = animGraphToSerialized(doc);
    serialized.nodes[0]!.position = { x: 420, y: 160 };
    const next = serializedToAnimGraph(serialized, doc);
    expect(next.states[0]!.position).toEqual({ x: 420, y: 160 });
    expect(animGraphToSerialized(next).nodes[0]!.position).toEqual({
      x: 420,
      y: 160,
    });
  });

  it("preserves transition condition and blend fields across a graph-ui round-trip", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
    const next = serializedToAnimGraph(animGraphToSerialized(doc), doc);
    expect(next.transitions[0]).toMatchObject({
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
  });

  it("keeps transition fields when the canvas edge id changes", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
    const serialized = animGraphToSerialized(doc);
    serialized.edges[0] = { ...serialized.edges[0]!, id: "canvas-edge-1" };
    const next = serializedToAnimGraph(serialized, doc);
    expect(next.transitions[0]).toMatchObject({
      id: "canvas-edge-1",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
  });

  it("assigns fallback layout when a document-chunk omits position", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [
        { id: "idle", name: "Idle", clipId: null, speed: 1, loop: true },
        { id: "run", name: "Run", clipId: null, speed: 1, loop: true },
      ],
      transitions: [],
      clips: [],
      parameters: [],
    });
    expect(parsed?.states[0]!.position).toEqual({ x: 80, y: 80 });
    expect(parsed?.states[1]!.position).toEqual({ x: 300, y: 80 });
  });

  it("round-trips stored positions through parse", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [
        {
          id: "idle",
          name: "Idle",
          clipId: null,
          speed: 1,
          loop: true,
          position: { x: 12, y: 34 },
        },
      ],
      transitions: [],
      clips: [],
      parameters: [],
    });
    expect(parsed?.states[0]!.position).toEqual({ x: 12, y: 34 });
  });
});

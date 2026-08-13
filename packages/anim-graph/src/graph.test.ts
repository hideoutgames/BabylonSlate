import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  evaluateAnimGraph,
  validateAnimGraph,
  animGraphToSerialized,
  serializedToAnimGraph,
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
});

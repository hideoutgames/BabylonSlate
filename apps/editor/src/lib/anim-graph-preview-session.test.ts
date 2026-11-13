import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  createStateGraph,
  type AnimGraphDocument,
} from "@haptic/anim-graph";
import type { SerializedGraph } from "@haptic/core";
import type { GraphRunEvent } from "@haptic/graph-ui";
import { compileAnimGraphScripts } from "../services/script-compiler";
import { ANIM_PREVIEW_STEP_SECONDS, AnimGraphPreviewSession } from "./anim-graph-preview-session";

const GUID = "loco-graph";

/** A rule whose Enter State reads the Bool variable `name`. */
function ruleOn(name: string): SerializedGraph {
  return {
    nodes: [
      { id: "enter-state", type: "anim.rule.enterState", position: { x: 0, y: 0 }, data: { __protected: true } },
      { id: "exit-state", type: "anim.rule.exitState", position: { x: 0, y: 80 }, data: { __protected: true } },
      { id: "get", type: "variables.get", position: { x: -200, y: 0 }, data: { variableId: `var-${name}`, variableName: name, typeId: "bool", implicitSelf: true } },
    ],
    edges: [{ id: "get-enter", source: "get", sourceHandle: "value", target: "enter-state", targetHandle: "value" }],
  };
}

/** Idle → Run while Go is on, with a Speed float for the values tests. */
function locomotion(): AnimGraphDocument {
  const doc = createDefaultAnimGraph("Loco");
  doc.variables.push(
    { id: "var-Go", name: "Go", typeId: "bool", defaultValue: false },
    { id: "var-Speed", name: "Speed", typeId: "float", defaultValue: 1.5 },
  );
  doc.stateMachine.states.push({ id: "run", name: "Run", position: { x: 300, y: 80 }, stateGraph: createStateGraph("3d") });
  doc.stateMachine.transitions.push({
    id: "idle-to-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0, priority: 0,
    ruleGraph: ruleOn("Go"), sourceHandle: "right-out", targetHandle: "left-in",
  });
  return doc;
}

async function startSession(doc = locomotion()) {
  const session = new AnimGraphPreviewSession();
  session.setDocument(doc, GUID);
  await session.loadScripts(compileAnimGraphScripts([{ guid: GUID, path: "assets/Loco.anim3d.hasset", document: doc }]));
  return session;
}

describe("AnimGraphPreviewSession", () => {
  it("runs the graph's compiled rules on Preview Values, which start at each variable's default", async () => {
    const session = await startSession();
    expect(session.getSnapshot().values).toEqual({ Go: false, Speed: 1.5 });
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(session.getSnapshot().state?.stateId).toBe("idle");
    session.setValue("Go", true);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(session.getSnapshot().state?.stateId).toBe("run");
  });

  it("holds every transition shut until the rules have loaded", () => {
    const session = new AnimGraphPreviewSession();
    session.setDocument(locomotion(), GUID);
    session.setValue("Go", true);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(session.getSnapshot().state?.stateId).toBe("idle");
  });

  it("lights the playing state and the transition it takes while the Preview window runs it, and holds them while paused", async () => {
    const session = await startSession();
    const runs: GraphRunEvent[] = [];
    const holds: boolean[] = [];
    session.runTrace.subscribe((run) => runs.push(run));
    session.runTrace.subscribeHold?.((held) => holds.push(held));
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    // The Preview window is closed: nothing lights.
    expect(runs).toEqual([]);
    session.setActive(true);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    session.setValue("Go", true);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(runs).toEqual([
      { nodes: ["idle"], edges: [] },
      { nodes: ["run"], edges: ["idle-to-run"] },
    ]);
    session.setPlaying(false);
    expect(holds).toEqual([false, true]);
  });

  it("advances real time only while playing, scaled by Speed, and Step advances one tick and pauses", async () => {
    const session = await startSession();
    session.restart();
    session.setSpeed(0.5);
    session.advanceRealTime(0.04);
    expect(session.getSnapshot().state?.facts.elapsedSeconds).toBeCloseTo(0.02, 5);
    session.setPlaying(false);
    session.advanceRealTime(0.04);
    expect(session.getSnapshot().state?.facts.elapsedSeconds).toBeCloseTo(0.02, 5);
    session.setPlaying(true);
    session.step();
    expect(session.getSnapshot().playing).toBe(false);
    expect(session.getSnapshot().state?.facts.elapsedSeconds).toBeCloseTo(0.02 + 1 / 60, 5);
    // A long frame (a hidden tab) advances at most a tenth of a second.
    session.setPlaying(true);
    session.setSpeed(1);
    session.advanceRealTime(5);
    expect(session.getSnapshot().state?.facts.elapsedSeconds).toBeCloseTo(0.02 + 1 / 60 + 0.1, 5);
  });

  it("restarts in the entry state and keeps Preview Values; Reset Values returns them to their defaults", async () => {
    const session = await startSession();
    session.setValue("Go", true);
    session.setValue("Speed", 4);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(session.getSnapshot().state?.stateId).toBe("run");
    // Nothing leads back from Run: only Restart returns to the entry state.
    session.setValue("Go", false);
    session.tick(ANIM_PREVIEW_STEP_SECONDS);
    expect(session.getSnapshot().state?.stateId).toBe("run");
    session.restart();
    expect(session.getSnapshot().state?.stateId).toBe("idle");
    expect(session.getSnapshot().state?.facts.elapsedSeconds).toBe(0);
    expect(session.getSnapshot().values).toEqual({ Go: false, Speed: 4 });
    session.resetValues();
    expect(session.getSnapshot().values).toEqual({ Go: false, Speed: 1.5 });
  });

  it("keeps a value across edits while its variable keeps its type, and starts a retyped or new variable at its default", async () => {
    const doc = locomotion();
    const session = await startSession(doc);
    session.setValue("Go", true);
    session.setValue("Speed", 3);
    session.setDocument({
      ...doc,
      variables: [
        { id: "var-Go", name: "Go", typeId: "bool", defaultValue: false },
        { id: "var-Speed", name: "Speed", typeId: "string", defaultValue: "fast" },
        { id: "var-Crouch", name: "Crouch", typeId: "bool", defaultValue: true },
      ],
    }, GUID);
    expect(session.getSnapshot().values).toEqual({ Go: true, Speed: "fast", Crouch: true });
  });
});

import { describe, expect, it } from "vitest";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  createStateGraph,
  evaluateAnimGraph,
  parseAnimGraphDocument,
  serializedToStateMachine,
  stateMachineToSerialized,
  validateAnimGraph,
  type AnimGraphDocument,
  type AnimState,
  type AnimStateAlias,
  type AnimTransition,
} from "./index";

function state(id: string): AnimState {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), position: { x: 0, y: 0 }, stateGraph: createStateGraph("3d", { assetGuid: id, durationMs: 1000 }) };
}

function transition(id: string, fromStateId: string, toStateId: string, priority = 0): AnimTransition {
  return { id, fromStateId, toStateId, blendSeconds: 0, priority, ruleGraph: createDefaultTransitionRuleGraph() };
}

/** Idle ⇄ Move, a Hit state, and an alias into Hit. */
function hitGraph(alias: Partial<AnimStateAlias>, entryStateId = "idle"): AnimGraphDocument {
  return {
    ...createDefaultAnimGraph("Loco"),
    stateMachine: {
      entryStateId,
      states: [state("idle"), state("move"), state("hit")],
      aliases: [{ id: "struck", name: "Struck", position: { x: 0, y: 300 }, anyState: false, stateIds: [], ...alias }],
      transitions: [transition("idle-to-move", "idle", "move", 1), transition("struck-to-hit", "struck", "hit")],
    },
  };
}

/** Only `open` transitions pass. */
const only = (...open: string[]) => ({ decideTransition: (row: AnimTransition) => ({ enter: open.includes(row.id), exit: true }) });

describe("State Alias", () => {
  it("leaves from each state it covers, and not from the others", () => {
    const fromMove = hitGraph({ stateIds: ["move"] }, "move");
    expect(evaluateAnimGraph(fromMove, null, 0.1, only("struck-to-hit")).stateId).toBe("hit");
    const fromIdle = hitGraph({ stateIds: ["move"] }, "idle");
    expect(evaluateAnimGraph(fromIdle, null, 0.1, only("struck-to-hit")).stateId).toBe("idle");
  });

  it("leaves from every state with Any State, but never re-enters the state already playing", () => {
    const any = hitGraph({ anyState: true });
    expect(evaluateAnimGraph(any, null, 0.1, only("struck-to-hit")).stateId).toBe("hit");
    const inHit = hitGraph({ anyState: true }, "hit");
    const held = evaluateAnimGraph(inHit, null, 0.1, only("struck-to-hit"));
    expect(held.stateId).toBe("hit");
    // Not restarted: its time ran on.
    expect(evaluateAnimGraph(inHit, held, 0.1, only("struck-to-hit")).normalisedTime).toBeCloseTo(0.2, 6);
  });

  it("takes its turn among a state's own transitions by priority", () => {
    // Idle → Move has priority 1, the alias's transition 0: the alias wins when both pass.
    const graph = hitGraph({ stateIds: ["idle"] });
    expect(evaluateAnimGraph(graph, null, 0.1, only("struck-to-hit", "idle-to-move")).stateId).toBe("hit");
  });

  it("round-trips through the document and the State Machine canvas", () => {
    const doc = hitGraph({ stateIds: ["idle", "move", "gone"] });
    const parsed = parseAnimGraphDocument(JSON.parse(JSON.stringify(doc)), "3d")!;
    // A covered state that does not exist is dropped.
    expect(parsed.stateMachine.aliases).toEqual([{ id: "struck", name: "Struck", position: { x: 0, y: 300 }, anyState: false, stateIds: ["idle", "move"] }]);
    const canvas = stateMachineToSerialized(parsed.stateMachine);
    expect(canvas.nodes.find((node) => node.id === "struck")).toMatchObject({ type: "anim.alias", data: { title: "Struck", anyState: false, stateCount: 2 } });
    // Deleting Move on the canvas drops it from the alias; a new alias from the palette covers every state.
    const edited = serializedToStateMachine(
      {
        nodes: [
          ...canvas.nodes.filter((node) => node.id !== "move"),
          { id: "fall", type: "anim.alias", position: { x: 0, y: 0 }, data: { title: "State Alias", anyState: true } },
        ],
        edges: canvas.edges.filter((edge) => edge.source !== "move" && edge.target !== "move"),
      },
      parsed.stateMachine,
      "3d",
    );
    expect(edited.states.map((row) => row.id)).toEqual(["idle", "hit"]);
    expect(edited.aliases).toEqual([
      { id: "struck", name: "Struck", position: { x: 0, y: 300 }, anyState: false, stateIds: ["idle"] },
      { id: "fall", name: "State Alias", position: { x: 0, y: 0 }, anyState: true, stateIds: [] },
    ]);
    expect(edited.transitions.map((row) => row.id)).toEqual(["struck-to-hit"]);
  });

  it("reports a transition into an alias, and an alias that covers nothing", () => {
    const doc = hitGraph({});
    doc.stateMachine.transitions.push(transition("idle-to-struck", "idle", "struck"));
    const codes = validateAnimGraph(doc).map((row) => [row.code, row.severity]);
    expect(codes).toContainEqual(["anim.emptyAlias", "warning"]);
    expect(codes).toContainEqual(["anim.badTransition", "error"]);
    expect(validateAnimGraph(hitGraph({ anyState: true })).map((row) => row.code)).toEqual([]);
  });
});

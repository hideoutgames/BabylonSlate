import { describe, expect, it } from "vitest";
import type { CommandMessage, DebugGraphTrace, DebugObserveTarget } from "@babylonslate/bridge";
import { createDefaultAnimGraph, type AnimGraphDocument } from "@babylonslate/anim-graph";
import { btEdgeId, createDefaultBehaviourTree, type BehaviourTreeDocument, type BtNode } from "@babylonslate/behaviour-tree";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

type Row = { id: string; classId: string; properties?: Record<string, unknown> };

function btNode(id: string, kind: BtNode["kind"], classId: string, children: string[] = [], properties: Record<string, unknown> = {}): BtNode {
  return { id, kind, classId, children, decorators: [], services: [], properties };
}

/** A Selector whose first child fails, so the second (a Sequence holding a 250 ms Wait) runs. */
function guardTree(): BehaviourTreeDocument {
  return {
    name: "Guard", rootId: "root", blackboardGuid: null,
    nodes: [
      btNode("root", "selector", "bt.composite.selector", ["blocked", "patrol"]),
      btNode("blocked", "task", "bt.task.fail"),
      btNode("patrol", "sequence", "bt.composite.sequence", ["wait"]),
      btNode("wait", "task", "bt.task.wait", [], { durationMs: 250 }),
    ],
  };
}

function sceneOf(actors: Array<{ id: string; name: string; components: Row[] }>): SerializedScene {
  return {
    name: "Level", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [],
    actors: actors.map((actor) => createActor(actor.id, actor.name, {
      components: actor.components.map((component) => ({ properties: {}, ...component })),
    })),
  };
}

function start(options: Partial<Parameters<typeof createInProcessRuntime>[0]>) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, dt: 0.1, ...options, onCommand: (command) => commands.push(command),
  });
  runtime.start();
  runtime.realizePlayWorld();
  const traces = (from = 0) => commands.slice(from).flatMap((command) => command.type === "executionTrace" ? [command] : []);
  const graphs = (from: number, graphId: string): DebugGraphTrace[] =>
    traces(from).flatMap((trace) => trace.graphs.filter((graph) => graph.graphId === graphId));
  const roster = (target: DebugObserveTarget) => {
    const entries = new Map<string, { id: string; label: string; ownerLabel?: string }>();
    for (const command of commands) {
      if (command.type !== "debugRoster" || JSON.stringify(command.target) !== JSON.stringify(target)) continue;
      if (command.reset) entries.clear();
      for (const id of command.removed) entries.delete(id);
      for (const instance of command.added) entries.set(instance.id, instance);
    }
    return [...entries.values()];
  };
  return { runtime, commands, traces, graphs, roster };
}

const bt = (assetGuid: string) => ({ kind: "behaviourTree", assetGuid }) as const;
const anim = (assetGuid: string) => ({ kind: "animationGraph", assetGuid }) as const;

describe("Behaviour Tree graph debugging", () => {
  const guards = () => sceneOf([
    { id: "g1", name: "Guard", components: [{ id: "bt-1", classId: "BehaviourTreeComponent", properties: { treeGuid: "guard" } }] },
    { id: "g2", name: "Scout", components: [{ id: "bt-2", classId: "BehaviourTreeComponent", properties: { treeGuid: "guard" } }] },
    { id: "g3", name: "Cook", components: [{ id: "bt-3", classId: "BehaviourTreeComponent", properties: { treeGuid: "kitchen" } }] },
  ]);
  const trees = () => ({ guard: guardTree(), kitchen: createDefaultBehaviourTree("Kitchen") });

  it("lists the components that run the tree, by the tree they evaluate", () => {
    const { runtime, roster } = start({ playScene: guards(), behaviourTrees: trees() });
    runtime.applyDebugObserve(bt("guard"), null);
    // A component is named for its actor.
    expect(roster(bt("guard")).map((entry) => [entry.id, entry.label, entry.ownerLabel])).toEqual([
      ["bt-1", "Guard", undefined],
      ["bt-2", "Scout", undefined],
    ]);
    runtime.applyDebugObserve(bt("kitchen"), null);
    expect(roster(bt("kitchen")).map((entry) => entry.id)).toEqual(["bt-3"]);
  });

  it("lists only the tree an actor evaluates, and drops a component that switches trees", () => {
    const scene = sceneOf([{
      id: "g1", name: "Guard", components: [
        { id: "first", classId: "BehaviourTreeComponent", properties: { treeGuid: "guard" } },
        { id: "second", classId: "BehaviourTreeComponent", properties: { treeGuid: "kitchen" } },
      ],
    }]);
    const { runtime, roster } = start({ playScene: scene, behaviourTrees: trees() });
    // The actor's second component never runs, so there is nothing of its tree to follow.
    runtime.applyDebugObserve(bt("kitchen"), null);
    expect(roster(bt("kitchen"))).toEqual([]);

    runtime.applyDebugObserve(bt("guard"), null);
    expect(roster(bt("guard")).map((entry) => entry.id)).toEqual(["first"]);
    runtime.getWorld().findActor("g1")!.components[0]!.setVariable("treeGuid", "kitchen");
    runtime.tick();
    expect(roster(bt("guard"))).toEqual([]);
    runtime.applyDebugObserve(bt("kitchen"), null);
    expect(roster(bt("kitchen")).map((entry) => entry.id)).toEqual(["first"]);
  });

  it("reports the nodes and links an evaluation touched, and only for the followed component", () => {
    const { runtime, commands, graphs } = start({ playScene: guards(), behaviourTrees: trees() });
    runtime.applyDebugObserve(bt("guard"), "bt-2");
    const mark = commands.length;
    runtime.tick();
    expect(graphs(mark, "behaviour-tree")).toEqual([{
      assetGuid: "guard", graphId: "behaviour-tree",
      nodes: ["root", "blocked", "patrol", "wait"],
      edges: [btEdgeId("root", "blocked"), btEdgeId("root", "patrol"), btEdgeId("patrol", "wait")],
      values: [],
    }]);
    expect(commands.slice(mark).filter((command) => command.type === "executionTrace")).toHaveLength(1);
  });

  it("keeps ticking the running leaf while the tree waits", () => {
    const { runtime, commands, graphs } = start({ playScene: guards(), behaviourTrees: trees() });
    runtime.applyDebugObserve(bt("guard"), "bt-1");
    runtime.tick();
    const mark = commands.length;
    runtime.tick();
    expect(graphs(mark, "behaviour-tree")).toEqual([{
      assetGuid: "guard", graphId: "behaviour-tree", nodes: ["wait"], edges: [], values: [],
    }]);
  });

  it("publishes the followed tree's state with its component, and nothing for the others", () => {
    const { runtime, commands } = start({ playScene: guards(), behaviourTrees: trees() });
    runtime.tick();
    runtime.applyDebugObserve(bt("guard"), "bt-2");
    const states = commands.filter((command) => command.type === "btState");
    expect(states).toEqual([expect.objectContaining({ instanceId: "bt-2", status: "running", btNodeId: "wait" })]);
    runtime.tick();
    runtime.tick();
    expect(commands.filter((command) => command.type === "btState").every((state) => state.type === "btState" && state.instanceId === "bt-2")).toBe(true);
  });

  it("stops reporting when the follow ends", () => {
    const { runtime, commands, traces } = start({ playScene: guards(), behaviourTrees: trees() });
    runtime.applyDebugObserve(bt("guard"), "bt-1");
    runtime.tick();
    runtime.applyDebugObserve(bt("guard"), null);
    const mark = commands.length;
    runtime.tick();
    runtime.tick();
    expect(traces(mark)).toEqual([]);
    expect(commands.slice(mark).filter((command) => command.type === "btState")).toEqual([]);
  });
});

describe("Animation Graph debugging", () => {
  const heroes = () => sceneOf([
    { id: "h1", name: "Hero", components: [
      { id: "anim-1", classId: "AnimationGraphComponent", properties: { graphGuid: "loco" } },
      { id: "anim-2", classId: "AnimationGraphComponent", properties: { graphGuid: "face" } },
    ] },
    { id: "h2", name: "Villain", components: [{ id: "anim-3", classId: "AnimationGraphComponent", properties: { graphGuid: "loco" } }] },
  ]);
  const locomotion = (): AnimGraphDocument => {
    const document = createDefaultAnimGraph("Locomotion");
    document.states.push({ ...document.states[0]!, id: "run", name: "Run" });
    const rule = createDefaultAnimGraph().animationObject;
    document.transitions.push(
      { id: "idle-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0, priority: 0, ruleGraph: rule },
      { id: "run-idle", fromStateId: "run", toStateId: "idle", blendSeconds: 0.2, priority: 0, ruleGraph: rule },
    );
    return document;
  };
  /** A transition rule that opens when the component's `go` variable is true, and only then enters Run. */
  const rule = (transitionId: string, open: string): CompiledScript => ({
    assetGuid: `loco/${transitionId}`, classId: `AnimRule:loco:${transitionId}`, parentClassId: "BObject",
    source: `export function evaluate(ctx) { return { enter: ${open}, exit: true }; }`,
    anchors: [], entryPoints: [{ name: "evaluate", event: "onAnimRule", isAsync: false }],
  });
  const scripts = () => [
    rule("idle-run", 'ctx.getVariable("go") === true'),
    rule("run-idle", 'ctx.getVariable("go") !== true'),
  ];

  async function startHeroes(extra: CompiledScript[] = []) {
    const run = start({ playScene: heroes(), animGraphs: { loco: locomotion(), face: createDefaultAnimGraph("Face") } });
    await run.runtime.loadScripts([...scripts(), ...extra]);
    return run;
  }

  it("lists every component that runs the graph, including a second one on the same actor", async () => {
    const { runtime, roster } = await startHeroes();
    runtime.applyDebugObserve(anim("loco"), null);
    expect(roster(anim("loco")).map((entry) => [entry.id, entry.label])).toEqual([["anim-1", "Hero"], ["anim-3", "Villain"]]);
    runtime.applyDebugObserve(anim("face"), null);
    expect(roster(anim("face")).map((entry) => entry.id)).toEqual(["anim-2"]);
  });

  it("samples the active state every tick and flashes a transition when it is taken", async () => {
    const { runtime, commands, graphs } = await startHeroes();
    runtime.applyDebugObserve(anim("loco"), "anim-1");
    let mark = commands.length;
    runtime.tick();
    runtime.tick();
    expect(graphs(mark, "state-machine")).toEqual([
      { assetGuid: "loco", graphId: "state-machine", nodes: ["idle"], edges: [], values: [] },
      { assetGuid: "loco", graphId: "state-machine", nodes: ["idle"], edges: [], values: [] },
    ]);

    runtime.getWorld().findActor("h1")!.components[0]!.setVariable("go", true);
    mark = commands.length;
    runtime.tick();
    expect(graphs(mark, "state-machine")).toEqual([
      { assetGuid: "loco", graphId: "state-machine", nodes: ["run"], edges: ["idle-run"], values: [] },
    ]);
  });

  it("draws the reverse transition of a Both Ways pair on the one edge the canvas has", async () => {
    const { runtime, commands, graphs } = await startHeroes();
    runtime.applyDebugObserve(anim("loco"), "anim-1");
    const hero = runtime.getWorld().findActor("h1")!.components[0]!;
    hero.setVariable("go", true);
    runtime.tick();
    hero.setVariable("go", false);
    const mark = commands.length;
    runtime.tick();
    // Run -> Idle is its own row, drawn on the Idle -> Run edge; it blends, so Run is still sampled.
    expect(graphs(mark, "state-machine")).toEqual([
      { assetGuid: "loco", graphId: "state-machine", nodes: ["idle", "run"], edges: ["idle-run"], values: [] },
    ]);
  });

  it("reports only the followed component", async () => {
    const { runtime, commands, traces } = await startHeroes();
    runtime.applyDebugObserve(anim("loco"), "anim-3");
    const mark = commands.length;
    runtime.tick();
    expect(traces(mark)).toHaveLength(1);
    expect(traces(mark)[0]).toMatchObject({ instanceId: "anim-3", target: anim("loco") });
  });

  it("hands the Animation Object graph's scripts the followed component's recorder, and no other component", async () => {
    const object: CompiledScript = {
      assetGuid: "Content/Loco.animgraph", classId: "AnimGraph:loco", parentClassId: "BObject",
      source: [
        "export function onUpdateAnimation(ctx) {",
        '  const __dbg = ctx.debugTrace === null ? null : ctx.debugTrace.graph("Content/Loco.animgraph", "animation-object");',
        '  if (__dbg !== null) __dbg.exec("update");',
        "}",
      ].join("\n"),
      anchors: [], entryPoints: [{ name: "onUpdateAnimation", event: "onUpdateAnimation", isAsync: false }],
    };
    const { runtime, commands, graphs } = await startHeroes([object]);
    runtime.applyDebugObserve(anim("loco"), "anim-3");
    const mark = commands.length;
    runtime.tick();
    // Both loco components run the script; only the followed one reached a recorder.
    expect(graphs(mark, "animation-object")).toEqual([
      { assetGuid: "Content/Loco.animgraph", graphId: "animation-object", nodes: ["update"], edges: [], values: [] },
    ]);
  });
});

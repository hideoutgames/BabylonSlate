import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor } from "@haptic/core";
import type { GraphEdge, GraphNode, LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

type Step = GraphNode | { print: string } | { printOf: [nodeId: string, pinId: string] };

/** One exec chain from `event`, in order; Print steps print a literal or a source output. Sources join unwired. */
function chain(prefix: string, event: string, steps: Step[], sources: GraphNode[] = []): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entry = graphNode(registry, `${prefix}-event`, event);
  const nodes: GraphNode[] = [entry, ...sources];
  const edges: GraphEdge[] = [];
  let previous = entry.id;
  steps.forEach((step, index) => {
    const node = "id" in step ? step
      : graphNode(registry, `${prefix}-print${index}`, "debug.print", "print" in step ? { "default:value": step.print } : {});
    nodes.push(node);
    edges.push(wire(previous, "execOut", node.id, "execIn"));
    if ("printOf" in step) edges.push(wire(step.printOf[0], step.printOf[1], node.id, "value"));
    previous = node.id;
  });
  return { nodes, edges };
}

function graphOf(...chains: { nodes: GraphNode[]; edges: GraphEdge[] }[]): LogicGraph {
  return { id: "event-graph", kind: "event", nodes: chains.flatMap((c) => c.nodes), edges: chains.flatMap((c) => c.edges) };
}

function printed(scenario: GraphScenario): string[] {
  return scenario.commands.flatMap((command) => command.type === "print" ? [command.message] : []);
}

function after<T extends CommandMessage["type"]>(scenario: GraphScenario, from: number, type: T): Extract<CommandMessage, { type: T }>[] {
  return scenario.commands.slice(from).filter((command): command is Extract<CommandMessage, { type: T }> => command.type === type);
}

/**
 * Player: plays music on Begin Play, then waits 0.05 s; prints each Tick. Menu (Tick On Pause): pauses the
 * game on Begin Play, plays a click, then waits 0.05 s; prints each Tick with game and real time.
 */
async function play(): Promise<GraphScenario> {
  const player = graphOf(
    chain("b", "flow.event.beginPlay", [
      graphNode(registry, "music", "audio.play", { "default:asset": "music" }),
      graphNode(registry, "wait", "timers.delay", { "default:duration": 0.05 }),
      { print: "player waited" },
    ]),
    chain("t", "flow.event.tick", [{ print: "player tick" }]),
  );
  const menu = graphOf(
    chain("b", "flow.event.beginPlay", [
      graphNode(registry, "pause", "system.setGamePaused"),
      { printOf: ["paused", "paused"] },
      graphNode(registry, "click", "audio.play", { "default:asset": "click" }),
      graphNode(registry, "wait", "timers.delay", { "default:duration": 0.05 }),
      { print: "menu waited" },
    ], [graphNode(registry, "paused", "system.isGamePaused")]),
    chain("t", "flow.event.tick", [{ printOf: ["game", "seconds"] }, { printOf: ["real", "seconds"] }], [
      graphNode(registry, "game", "time.getGameTimeSeconds"),
      graphNode(registry, "real", "time.getRealTimeSeconds"),
    ]),
  );
  return startGraphScenario({
    scripts: [
      compileClassScript({ registry, classId: "Player", graph: player }),
      { ...compileClassScript({ registry, classId: "Menu", graph: menu }), actorDefaults: { tickOnPause: true } },
    ],
    actors: [createActor("player", "Player", { classId: "Player" }), createActor("menu", "Menu", { classId: "Menu" })],
    // 1/32 s sums exactly, so printed times are hand-checkable.
    dt: 1 / 32,
  });
}

/** A Game Instance class that prints each Tick, with or without Tick On Pause in its class defaults. */
async function playWithGameInstance(tickOnPause: boolean | undefined): Promise<GraphScenario> {
  const gameInstance = graphOf(
    chain("i", "flow.event.init", [graphNode(registry, "pause", "system.setGamePaused")]),
    chain("t", "flow.event.tick", [{ print: "game instance tick" }]),
  );
  const script = { ...compileClassScript({ registry, classId: "SessionGI", parentClassId: "GameInstance", graph: gameInstance }) };
  return startGraphScenario({
    scripts: [tickOnPause === undefined ? script : { ...script, gameInstanceDefaults: { tickOnPause } }],
    runtime: { gameInstanceClass: "SessionGI" },
  });
}

describe("Set Game Paused", () => {
  it("keeps ticking only actors with Tick On Pause, with their Delays, holding game time but not real time", async () => {
    const scenario = await play();
    expect(printed(scenario)).toEqual(["true"]);
    await scenario.tick(3);
    expect(scenario.runtime.isGamePaused()).toBe(true);
    // The menu's 0.05 s Delay ends in the second step (0.0625 s); the player neither ticks nor waits.
    expect(printed(scenario)).toEqual(["true", "0", "0.03125", "0", "0.0625", "menu waited", "0", "0.09375"]);

    const before = printed(scenario).length;
    scenario.runtime.setGamePaused(false);
    await scenario.tick(3);
    scenario.stop();
    expect(printed(scenario).slice(before)).toEqual([
      "player tick", "0.03125", "0.125",
      "player tick", "0.0625", "0.15625", "player waited",
      "player tick", "0.09375", "0.1875",
    ]);
    expect(scenario.diagnostics()).toEqual([]);
  });

  it("holds sounds whose owner does not tick on pause and freezes render-side clocks until it ends", async () => {
    const scenario = await play();
    const voiceOf = (asset: string) => after(scenario, 0, "playSound").find((command) => command.assetGuid === asset)?.voiceId;
    const music = voiceOf("music");
    expect(music).toBeTruthy();
    expect(voiceOf("click")).toBeTruthy();

    const paused = scenario.commands.length;
    await scenario.tick();
    expect(after(scenario, paused, "setVoicePaused")).toEqual([{ type: "setVoicePaused", voiceId: music, paused: true }]);
    expect(after(scenario, paused, "setSimulationTimeScale")).toEqual([{ type: "setSimulationTimeScale", scale: 0 }]);

    const resumed = scenario.commands.length;
    scenario.runtime.setGamePaused(false);
    await scenario.tick();
    scenario.stop();
    expect(after(scenario, resumed, "setVoicePaused")).toEqual([{ type: "setVoicePaused", voiceId: music, paused: false }]);
    expect(after(scenario, resumed, "setSimulationTimeScale")).toEqual([{ type: "setSimulationTimeScale", scale: 1 }]);
  });

  it("keeps the Game Instance ticking only when its class defaults set Tick On Pause", async () => {
    for (const [tickOnPause, ticks] of [[undefined, []], [false, []], [true, ["game instance tick", "game instance tick"]]] as const) {
      const scenario = await playWithGameInstance(tickOnPause);
      const before = printed(scenario).length;
      await scenario.tick(2);
      scenario.stop();
      expect(printed(scenario).slice(before), `tickOnPause ${String(tickOnPause)}`).toEqual(ticks);
    }
  });
});

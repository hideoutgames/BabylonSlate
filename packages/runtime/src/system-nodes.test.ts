import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, type GameEnvironment } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import type { GraphEdge, GraphNode, LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

/** `event` → each node in order; a `[nodeId, pinId]` step is a Print of that output. */
function graph(event: string, steps: (GraphNode | [string, string])[], sources: GraphNode[] = []): LogicGraph {
  const nodes: GraphNode[] = [graphNode(registry, "event", event), ...sources];
  const edges: GraphEdge[] = [];
  let previous = "event";
  steps.forEach((step, index) => {
    const node = Array.isArray(step) ? graphNode(registry, `print${index}`, "debug.print") : step;
    nodes.push(node);
    edges.push(wire(previous, "execOut", node.id, "execIn"));
    if (Array.isArray(step)) edges.push(wire(step[0], step[1], node.id, "value"));
    previous = node.id;
  });
  return { id: "event-graph", kind: "event", nodes, edges };
}

async function play(logic: LogicGraph, environment?: GameEnvironment): Promise<GraphScenario> {
  return startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Probe", graph: logic })],
    actors: [createActor("probe", "Probe", { classId: "Probe" })],
    ...(environment ? { runtime: { environment } } : {}),
  });
}

function printed(scenario: GraphScenario): string[] {
  return scenario.commands.flatMap((command) => command.type === "print" ? [command.message] : []);
}

function commandsOf<T extends CommandMessage["type"]>(scenario: GraphScenario, type: T): Extract<CommandMessage, { type: T }>[] {
  return scenario.commands.filter((command): command is Extract<CommandMessage, { type: T }> => command.type === type);
}

const environmentProbe = () => graph("flow.event.beginPlay", [
  ["platform", "platform"], ["touch", "touchDevice"], ["editor", "inEditor"], ["development", "developmentBuild"],
], [
  graphNode(registry, "platform", "system.getPlatform"),
  graphNode(registry, "touch", "system.isTouchDevice"),
  graphNode(registry, "editor", "system.isInEditor"),
  graphNode(registry, "development", "system.isDevelopmentBuild"),
]);

describe("System nodes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("report the environment the host loads the session with", async () => {
    const scenario = await play(environmentProbe(), { platform: "iOS", touchDevice: true, inEditor: false, developmentBuild: false });
    scenario.stop();
    expect(printed(scenario)).toEqual(["iOS", "true", "false", "false"]);
  });

  it("report an unknown device outside the editor in a development build when the host reports nothing", async () => {
    const scenario = await play(environmentProbe());
    scenario.stop();
    expect(printed(scenario)).toEqual(["Other", "false", "false", "true"]);
  });

  it("read the game view's size and aspect ratio once the host reports it", async () => {
    const scenario = await play(graph("flow.event.tick", [["view", "size"], ["view", "aspectRatio"]], [
      graphNode(registry, "view", "system.getViewportSize"),
    ]));
    await scenario.tick();
    scenario.runtime.applySceneLayerResize(16, 9, 1280, 720);
    await scenario.tick();
    scenario.stop();
    expect(printed(scenario)).toEqual(["{x: 0, y: 0}", "0", "{x: 1280, y: 720}", String(16 / 9)]);
  });

  it("read the locale and its language", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ locale: "pt-BR" } as Intl.ResolvedDateTimeFormatOptions);
    const scenario = await play(graph("flow.event.beginPlay", [["locale", "locale"], ["locale", "language"]], [
      graphNode(registry, "locale", "system.getLocale"),
    ]));
    scenario.stop();
    expect(printed(scenario)).toEqual(["pt-BR", "pt"]);
  });

  it("make a new GUID each time", async () => {
    const scenario = await play(graph("flow.event.beginPlay", [["first", "guid"], ["second", "guid"]], [
      graphNode(registry, "first", "system.newGuid"),
      graphNode(registry, "second", "system.newGuid"),
    ]));
    scenario.stop();
    const [first, second] = printed(scenario);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-/);
    expect(second).not.toBe(first);
  });

  it("ask the host to copy text and open only http and https addresses", async () => {
    const scenario = await play(graph("flow.event.beginPlay", [
      graphNode(registry, "copy", "system.copyToClipboard", { "default:text": "Score: 42" }),
      graphNode(registry, "store", "system.openUrl", { "default:url": "https://example.com/store" }),
      graphNode(registry, "script", "system.openUrl", { "default:url": "javascript:alert(1)" }),
    ]));
    scenario.stop();
    expect(commandsOf(scenario, "copyToClipboard").map(({ text }) => text)).toEqual(["Score: 42"]);
    expect(commandsOf(scenario, "openUrl").map(({ url }) => url)).toEqual(["https://example.com/store"]);
    expect(scenario.logs("Script")).toEqual(['Open URL opens only http and https addresses, not "javascript:alert(1)".']);
  });

  it("quit the game once the current step finishes", async () => {
    const scenario = await play(graph("flow.event.tick", [
      graphNode(registry, "quit", "system.quitGame"),
      graphNode(registry, "after", "debug.print", { "default:value": "after Quit Game" }),
    ]));
    await scenario.tick();
    expect(printed(scenario)).toEqual(["after Quit Game"]);
    expect(commandsOf(scenario, "sessionEnded")).toHaveLength(1);
    expect(scenario.runtime.executeConsoleCommand("help")).toEqual({ success: false, output: "The runtime session has ended" });
    await scenario.tick();
    expect(printed(scenario)).toEqual(["after Quit Game"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { audioNodes, createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("audio nodes", () => {
  it("compiled Play Sound calls ctx.playSound with asset and volume", () => {
    expect(audioNodes.map((n) => n.id)).toContain("audio.play");
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "play", "audio.play", { asset: "jump.wav", volume: 0.5 }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "play",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.playSound");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const plays: Array<[string, number]> = [];
    mod.onBeginPlay({
      playSound: (asset: string, volume: number) => {
        plays.push([asset, volume]);
      },
    });
    expect(plays).toEqual([["jump.wav", 0.5]]);
  });

  it("Play Sound uses an Audio assetRef pin and defaults volume to 1", () => {
    const registry = createDefaultNodeRegistry();
    const def = registry.get("audio.play");
    expect(def).toBeTruthy();
    const assetPin = def!.pins({}).find((pin) => pin.name === "asset");
    expect(assetPin?.type).toEqual({ kind: "assetRef", assetType: "Audio" });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "play", "audio.play", { "default:asset": "audio-1" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "play",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const plays: Array<[string, number]> = [];
    mod.onBeginPlay({
      playSound: (asset: string, volume: number) => {
        plays.push([asset, volume]);
      },
    });
    expect(plays).toEqual([["audio-1", 1]]);
  });

  it("compiled Set Channel Volume and Set Global Volume clamp 0..1", () => {
    expect(audioNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "audio.play",
        "audio.setChannelVolume",
        "audio.setGlobalVolume",
      ]),
    );
    const registry = createDefaultNodeRegistry();
    const channelPin = registry
      .get("audio.setChannelVolume")
      ?.pins({})
      .find((pin) => pin.name === "channel");
    expect(channelPin?.type).toEqual({
      kind: "assetRef",
      assetType: "AudioChannel",
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "channel", "audio.setChannelVolume", {
          "default:channel": "ch-1",
          "default:volume": 2,
        }),
        node(registry, "global", "audio.setGlobalVolume", {
          "default:volume": -0.5,
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "channel",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "channel",
          sourcePinId: "execOut",
          targetNodeId: "global",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const channels: Array<[string, number]> = [];
    const globals: number[] = [];
    mod.onBeginPlay({
      setChannelVolume: (channel: string, volume: number) => {
        channels.push([channel, volume]);
      },
      setGlobalVolume: (volume: number) => {
        globals.push(volume);
      },
    });
    expect(channels).toEqual([["ch-1", 1]]);
    expect(globals).toEqual([0]);
  });
});

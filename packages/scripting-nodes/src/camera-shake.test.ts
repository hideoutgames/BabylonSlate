import { describe, expect, it } from "vitest";
import { compileGraph, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

function runBeginPlay(
  nodes: Array<[string, string, Record<string, unknown>?]>,
  edges: Array<[string, string, string, string]>,
  ctx: Record<string, unknown>,
): void {
  const registry = createDefaultNodeRegistry();
  const graph: LogicGraph = {
    id: "g",
    kind: "event",
    nodes: [["begin", "flow.event.beginPlay"] as [string, string], ...nodes].map(([id, typeId, properties = {}]) => ({
      id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
    })),
    edges: edges.map(([sourceNodeId, sourcePinId, targetNodeId, targetPinId], index) => ({
      id: `e${index}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
    })),
  };
  const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({ formatValue: (value: unknown) => value, ...ctx });
}

describe("camera shake nodes", () => {
  it("passes Play Camera Shake's handle to the handle nodes, with Scale 1 and a blended stop by default", () => {
    const calls: unknown[][] = [];
    const record = (name: string) => (...args: unknown[]) => (calls.push([name, ...args]), name === "playCameraShake" ? { Id: 4 } : undefined);
    runBeginPlay(
      [["play", "camera.playShake", { "default:shake": "shake-guid" }], ["pause", "camera.pauseShake"],
        ["scale", "camera.setShakeScale", { "default:scale": 0.5 }], ["stop", "camera.stopShake"],
        ["world", "camera.playWorldShake", { "default:shake": "shake-guid", "default:epicenter": { x: 1, y: 2, z: 3 } }]],
      [["begin", "execOut", "play", "execIn"], ["play", "execOut", "pause", "execIn"], ["pause", "execOut", "scale", "execIn"],
        ["scale", "execOut", "stop", "execIn"], ["stop", "execOut", "world", "execIn"],
        ["play", "handle", "pause", "handle"], ["play", "handle", "scale", "handle"], ["play", "handle", "stop", "handle"]],
      {
        playCameraShake: record("playCameraShake"),
        setCameraShakePaused: record("setCameraShakePaused"),
        setCameraShakeScale: record("setCameraShakeScale"),
        stopCameraShake: record("stopCameraShake"),
        playWorldCameraShake: record("playWorldCameraShake"),
      },
    );
    expect(calls).toEqual([
      ["playCameraShake", "shake-guid", 1],
      ["setCameraShakePaused", { Id: 4 }, true],
      ["setCameraShakeScale", { Id: 4 }, 0.5],
      ["stopCameraShake", { Id: 4 }, false],
      ["playWorldCameraShake", "shake-guid", { x: 1, y: 2, z: 3 }, 0, 10, 1],
    ]);
  });
});

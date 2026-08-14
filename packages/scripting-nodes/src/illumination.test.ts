import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  createDefaultNodeRegistry,
  illuminationNodes,
} from "./index";

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

describe("illumination nodes", () => {
  it("registers Possess Camera and light/camera property nodes", () => {
    const ids = illuminationNodes.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "camera.possess",
        "camera.getFieldOfView",
        "camera.setFieldOfView",
        "camera.getOrthographicSize",
        "camera.setOrthographicSize",
        "light.setEnabled",
        "light.setColor",
        "light.setIntensity",
      ]),
    );
    const possess = illuminationNodes.find((entry) => entry.id === "camera.possess");
    expect(possess?.title).toBe("Possess Camera");
    expect(possess?.category).toBe("camera");
  });

  it("compiled Possess Camera calls ctx.possessCamera", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "possess", "camera.possess"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "possess",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "possess",
          targetPinId: "target",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.possessCamera");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const calls: unknown[] = [];
    const self = { guid: "cam-actor" };
    mod.onBeginPlay({
      self,
      possessCamera: (target: unknown) => {
        calls.push(target);
      },
    });
    expect(calls).toEqual([self]);
  });

  it("compiled set FOV / light intensity call ScriptHost helpers", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "fov", "camera.setFieldOfView"),
        node(registry, "intensity", "light.setIntensity"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "fov",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "fov",
          sourcePinId: "execOut",
          targetNodeId: "intensity",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.setCameraFieldOfView");
    expect(compiled.source).toContain("ctx.setLightIntensity");
  });
});

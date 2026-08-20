import { describe, expect, it } from "vitest";
import {
  compileGraph,
  classRef,
  TRANSFORM,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { componentNodes, createDefaultNodeRegistry } from "./index";

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

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)() as Record<
    string,
    unknown
  >;
}

describe("component nodes", () => {
  it("registers Add Component", () => {
    expect(componentNodes.map((n) => n.id)).toContain("component.add");
    expect(componentNodes.map((n) => n.id)).toContain("component.getNamed");
  });

  it("uses a classRef pin for component classId", () => {
    for (const id of ["component.get", "component.has", "component.add"] as const) {
      const def = componentNodes.find((node) => node.id === id);
      expect(def?.pins({}).find((entry) => entry.id === "classId")?.type).toEqual(
        classRef("ActorComponent"),
      );
    }
  });

  it("Get Component Ref uses typed objectRef and implicit self", () => {
    const def = componentNodes.find((node) => node.id === "component.getNamed");
    const pins = def?.pins({
      componentClassId: "MeshComponent",
      implicitSelf: true,
    });
    expect(pins?.find((entry) => entry.id === "actor")).toBeUndefined();
    expect(pins?.find((entry) => entry.id === "out")?.type).toEqual({
      kind: "objectRef",
      classId: "MeshComponent",
    });
  });

  it("compiled Add Component calls ctx.addComponent", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "add", "component.add", { classId: "MeshComponent" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "add",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "add",
          targetPinId: "actor",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.addComponent");
    const self = { classId: "Holder" };
    const added: string[] = [];
    const mod = loadModule(compiled.source);
    (mod.onBeginPlay as (ctx: unknown) => void)({
      self,
      addComponent: (actor: unknown, classId: string) => {
        expect(actor).toBe(self);
        added.push(classId);
        return { classId };
      },
    });
    expect(added).toEqual(["MeshComponent"]);
  });

  it("exposes an optional Transform pin on Add Component", () => {
    const add = componentNodes.find((node) => node.id === "component.add");
    const transformPin = add?.pins({}).find((entry) => entry.id === "transform");
    expect(transformPin).toMatchObject({
      name: "Transform",
      direction: "in",
      type: TRANSFORM,
      optional: true,
    });
  });

  it("compiled Add Component passes transform as the third addComponent argument", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "add", "component.add", { classId: "MeshComponent" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "add",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "add",
          targetPinId: "actor",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(
      /ctx\.addComponent\(\s*[^,]+,\s*[^,]+,\s*[^)]+\)/,
    );
    const self = { classId: "Holder" };
    const calls: Array<{ classId: string; transform: unknown }> = [];
    const mod = loadModule(compiled.source);
    (mod.onBeginPlay as (ctx: unknown) => void)({
      self,
      addComponent: (_actor: unknown, classId: string, transform: unknown) => {
        calls.push({ classId, transform });
        return { classId };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.classId).toBe("MeshComponent");
    expect(calls[0]?.transform).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });
});

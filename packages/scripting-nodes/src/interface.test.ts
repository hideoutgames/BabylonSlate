import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  callInterfaceTitle,
  createDefaultNodeRegistry,
  interfaceNodes,
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

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)() as Record<
    string,
    unknown
  >;
}

describe("callInterfaceTitle", () => {
  it("prefixes the method name with Call I", () => {
    expect(callInterfaceTitle("Apply Damage")).toBe("Call I Apply Damage");
  });
});

describe("interface nodes", () => {
  it("registers interface.call without a Call Interface title", () => {
    expect(interfaceNodes.map((n) => n.id)).toContain("interface.call");
    expect(interfaceNodes[0]?.title).toBe("Call");
  });

  it("compiled legacy Call Interface calls ctx.callInterface", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "call", "interface.call", {
          interfaceGuid: "iface-damageable",
          method: "ApplyDamage",
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "call",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "call",
          targetPinId: "target",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.callInterface");
    const self = { classId: "Enemy" };
    const calls: Array<[unknown, string, string]> = [];
    const mod = loadModule(compiled.source);
    (mod.onBeginPlay as (ctx: unknown) => void)({
      self,
      callInterface: (target: unknown, guid: string, method: string) => {
        calls.push([target, guid, method]);
        return {};
      },
    });
    expect(calls).toEqual([[self, "iface-damageable", "ApplyDamage"]]);
  });

  it("compiled Call I nodes pass args and destructure outputs", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "interface.call", {
          interfaceGuid: "iface-damageable",
          method: "Apply Damage",
          implicitSelf: true,
          pins: [
            { name: "exec", typeId: "exec", direction: "in" },
            { name: "then", typeId: "exec", direction: "out" },
            { name: "amount", typeId: "float", direction: "in" },
            { name: "remaining", typeId: "float", direction: "out" },
          ],
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "call",
          targetPinId: "exec",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.callInterface(ctx.self");
    expect(compiled.source).toContain('"iface-damageable"');
    expect(compiled.source).toContain('"Apply Damage"');
    expect(compiled.source).toMatch(/amount:/);
    expect(compiled.source).toMatch(/remaining:/);
    const calls: Array<[unknown, string, string, Record<string, unknown>]> = [];
    const mod = loadModule(compiled.source);
    (mod.onBeginPlay as (ctx: unknown) => void)({
      self: { classId: "Enemy" },
      callInterface: (
        target: unknown,
        guid: string,
        method: string,
        args: Record<string, unknown>,
      ) => {
        calls.push([target, guid, method, args]);
        return { remaining: 7 };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("iface-damageable");
    expect(calls[0]?.[2]).toBe("Apply Damage");
    expect(calls[0]?.[3]).toMatchObject({ amount: expect.anything() });
  });
});

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
  it("prefixes the method name with Call Interface", () => {
    expect(callInterfaceTitle("Apply Damage")).toBe(
      "Call Interface Apply Damage",
    );
    expect(callInterfaceTitle("  ")).toBe("Call Interface");
  });
});

describe("interface nodes", () => {
  it("registers interface.call without a Call Interface title", () => {
    expect(interfaceNodes.map((n) => n.id)).toContain("interface.call");
    expect(interfaceNodes[0]?.title).toBe("Call");
  });

  it("compiled Call Interface reads guid and method from node data, not pins", () => {
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
    expect(compiled.source).toContain('"iface-damageable"');
    expect(compiled.source).toContain('"ApplyDamage"');
    expect(compiled.source).not.toContain('ctx.input("interfaceGuid")');
    expect(compiled.source).not.toContain('ctx.input("method")');
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

  it("never exposes Interface GUID, method, or boxed result pins", () => {
    const registry = createDefaultNodeRegistry();
    const bare = node(registry, "call", "interface.call", {
      interfaceGuid: "iface-damageable",
      method: "Apply Damage",
    });
    const withStale = node(registry, "stale", "interface.call", {
      interfaceGuid: "iface-damageable",
      method: "Apply Damage",
      pins: [
        { name: "interfaceGuid", typeId: "string", direction: "in" },
        { name: "method", typeId: "string", direction: "in" },
        { name: "result", typeId: "object", direction: "out" },
        { name: "amount", typeId: "float", direction: "in" },
      ],
    });
    for (const call of [bare, withStale]) {
      expect(call.pins.map((pin) => pin.id)).not.toEqual(
        expect.arrayContaining(["interfaceGuid", "method", "result"]),
      );
    }
    expect(withStale.pins.some((pin) => pin.id === "amount")).toBe(true);
    expect(withStale.pins.some((pin) => pin.id === "target")).toBe(true);
  });

  it("signature pins include a Target of any object plus method I/O", () => {
    const registry = createDefaultNodeRegistry();
    const call = node(registry, "call", "interface.call", {
      method: "Apply Damage",
      pins: [
        { name: "amount", typeId: "float", direction: "in" },
        { name: "remaining", typeId: "float", direction: "out" },
      ],
    });
    const target = call.pins.find((pin) => pin.id === "target");
    expect(target).toMatchObject({
      name: "Target",
      direction: "in",
      type: { kind: "objectRef", classId: "BObject" },
    });
    expect(call.pins.some((pin) => pin.id === "amount")).toBe(true);
    expect(call.pins.some((pin) => pin.id === "remaining")).toBe(true);
    expect(call.pins.map((pin) => pin.id)).not.toEqual(
      expect.arrayContaining(["interfaceGuid", "method", "result"]),
    );
  });

  it("compiled Call Interface nodes pass args and destructure outputs", () => {
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

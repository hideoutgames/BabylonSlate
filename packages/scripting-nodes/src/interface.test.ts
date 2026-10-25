import { describe, expect, it } from "vitest";
import {
  compileGraph,
  validateGraphs,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
import {
  callInterfaceTitle,
  createDefaultNodeRegistry,
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
    expect(bare.pins.map((pin) => pin.id)).not.toEqual(
      expect.arrayContaining(["interfaceGuid", "method", "result"]),
    );
  });

  it("sends method arguments named target or result apart from the Target pin", () => {
    const registry = createDefaultNodeRegistry();
    const call = node(registry, "call", "interface.call", {
      interfaceGuid: "iface-aim",
      method: "Aim",
      implicitSelf: false,
      pins: [
        { name: "target", typeId: "float", direction: "in" },
        { name: "result", typeId: "float", direction: "out" },
      ],
      "default:target__arg": 7,
    });
    expect(call.pins.filter((pin) => pin.id === "target")).toHaveLength(1);
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "other", "actor.getSelf"),
        call,
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "call", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "other", sourcePinId: "out", targetNodeId: "call", targetPinId: "target" },
        { id: "e3", sourceNodeId: "call", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e4", sourceNodeId: "call", sourcePinId: "result", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const calls: unknown[] = [];
    const logged: string[] = [];
    (loadModule(compiled.source).onBeginPlay as (ctx: unknown) => void)({
      self: "guard",
      callInterface: (...args: unknown[]) => {
        calls.push(args);
        return { result: 4 };
      },
      formatValue: String,
      log: (_severity: string, _category: string, message: string) => logged.push(message),
    });
    expect(calls).toEqual([["guard", "iface-aim", "Aim", { target: 7 }]]);
    expect(logged).toEqual(["4"]);
  });

  it("validation exempts an unwired implicit-self Target, not an argument named target", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "interface.call", {
          interfaceGuid: "iface-aim",
          method: "Aim",
          implicitSelf: true,
          pins: [{ name: "target", typeId: "object", typeClassId: "Hero", direction: "in" }],
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "call", targetPinId: "execIn" },
      ],
    };
    const missing = validateGraphs([graph], { assetGuid: "a" }, { registry })
      .filter((d) => d.code === "pin.missing_input");
    expect(missing.map((d) => d.pinId)).toEqual(["target__arg"]);
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
      type: { kind: "objectRef", classId: "Object" },
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
    // implicitSelf: the unwired Target is the running object.
    expect(calls[0]?.[0]).toEqual({ classId: "Enemy" });
    expect(calls[0]?.[1]).toBe("iface-damageable");
    expect(calls[0]?.[2]).toBe("Apply Damage");
    expect(calls[0]?.[3]).toMatchObject({ amount: expect.anything() });
  });

  it.each([
    [true, ["self"], []],
    [undefined, [], ["Call (Target) tried to access null."]],
  ] as const)("an unwired Target with implicitSelf %s calls on %j and logs %j", (implicitSelf, expected, logged) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "interface.call", {
          interfaceGuid: "iface-damageable",
          method: "Apply Damage",
          ...(implicitSelf === undefined ? {} : { implicitSelf }),
        }),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "call", targetPinId: "execIn" },
      ],
    };
    const targets: unknown[] = [];
    const reported: string[] = [];
    (loadModule(compileGraph(graph, { assetGuid: "a", registry }).source).onBeginPlay as (ctx: unknown) => void)({
      self: "self",
      callInterface: (target: unknown) => {
        targets.push(target);
        return {};
      },
      nullAccess: (message: string) => reported.push(message),
    });
    // Only a Self-bound row reads Self; any other unwired Target is empty and the call is skipped.
    expect(targets).toEqual(expected);
    expect(reported).toEqual(logged);
  });
});

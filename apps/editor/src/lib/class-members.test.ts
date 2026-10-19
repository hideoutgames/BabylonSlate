import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  addCallEventNode,
  addCallFunctionNode,
  addClassMember,
  addVariableAccessNode,
  blueprintSectionsForClass,
  classAllowsMemberKind,
  completeClassMemberDrop,
  droppedRowsNotice,
  ensureCallParentForEvent,
  ensureEventNodeOnGraph,
  functionLibraryShowsEventGraphEmpty,
  isObjectInstanceVariableType,
  patchClassMember,
  pruneEventMembersToNodes,
  removeClassMember,
  renameCustomEvent,
  resolveClassMemberDrop,
} from "./class-members";

function emptyGraph(): SerializedGraph {
  return { nodes: [], edges: [] };
}

describe("addClassMember", () => {
  it("ignores a blank name", () => {
    const graph = emptyGraph();
    expect(addClassMember(graph, "function", "  ")).toBe(graph);
  });

  it("records functions, variables, and interfaces on the graph members list", () => {
    let graph = emptyGraph();
    graph = addClassMember(graph, "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "interface", "Damageable", () => "if-1");
    expect(graph.members).toEqual([
      {
        id: "fn-1",
        kind: "function",
        name: "Jump",
        pins: [
          { name: "exec", typeId: "exec", direction: "in" },
          { name: "then", typeId: "exec", direction: "out" },
        ],
      },
      { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "" },
    ]);
    expect(graph.nodes).toEqual([]);
  });

  it("seeds interface implementation pins and metadata", () => {
    const graph = addClassMember(emptyGraph(), "function", "Apply Damage", () => "fn-1", {
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "amount", typeId: "float", direction: "in" },
      ],
      implementsInterface: { assetGuid: "iface-1", methodName: "Apply Damage" },
    });
    expect(graph.members?.[0]).toMatchObject({
      name: "Apply Damage",
      implementsInterface: { assetGuid: "iface-1", methodName: "Apply Damage" },
    });
    expect(graph.functionGraphs?.["fn-1"]?.nodes[0]?.data.pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "amount", typeId: "float" }),
      ]),
    );
  });

  it("seeds a protected Input/Output function graph when adding a function", () => {
    const graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    const slice = graph.functionGraphs?.["fn-1"];
    expect(slice?.nodes).toHaveLength(2);
    expect(slice?.nodes.map((node) => node.type)).toEqual([
      "flow.function.input",
      "flow.function.output",
    ]);
    expect(slice?.nodes.every((node) => node.data.__protected === true)).toBe(
      true,
    );
    expect(slice?.edges).toEqual([
      expect.objectContaining({
        source: "fn-1-input",
        target: "fn-1-output",
        sourceHandle: "exec",
        targetHandle: "then",
      }),
    ]);
  });

  it("wires only Input exec to Output then when a signature has extra data pins", () => {
    const graph = addClassMember(emptyGraph(), "function", "Apply Damage", () => "fn-1", {
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "amount", typeId: "float", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "result", typeId: "float", direction: "out" },
      ],
    });
    const slice = graph.functionGraphs?.["fn-1"];
    expect(slice?.edges).toEqual([
      expect.objectContaining({
        source: "fn-1-input",
        target: "fn-1-output",
        sourceHandle: "exec",
        targetHandle: "then",
      }),
    ]);
    expect(slice?.edges).toHaveLength(1);
  });

  it("drops the function graph and this Class's own Call Function nodes when the function member is removed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addCallFunctionNode(graph, graph.members![0]!, { idFactory: () => "call-self" });
    graph = addCallFunctionNode(graph, graph.members![0]!, { classId: "Hero", idFactory: () => "call-hero" });
    graph = addCallFunctionNode(graph, { name: "Jump" }, {
      classId: "OtherActor",
      implicitSelf: false,
      idFactory: () => "call-other",
    });
    // A Function Library static Call of the same name, as the palette stamps it.
    graph = addCallFunctionNode(graph, { name: "Jump" }, { classId: "MathLib", idFactory: () => "call-library" });
    graph.nodes.find((node) => node.id === "call-library")!.data.static = true;
    graph = {
      ...graph,
      edges: [
        { id: "e1", source: "call-self", target: "call-other", sourceHandle: "then", targetHandle: "exec" },
        { id: "e2", source: "call-other", target: "call-library", sourceHandle: "then", targetHandle: "exec" },
      ],
    };
    graph = removeClassMember(graph, "fn-1", { classId: "Hero" });
    expect(graph.members).toEqual([]);
    expect(graph.functionGraphs?.["fn-1"]).toBeUndefined();
    expect(graph.nodes.map((node) => node.id)).toEqual(["call-other", "call-library"]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["e2"]);
  });

  it("points this Class's Calls at the parent function when a function of the parent's name is removed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addCallFunctionNode(graph, graph.members![0]!, { classId: "Hero", idFactory: () => "call-hero" });
    graph = addCallFunctionNode(graph, graph.members![0]!, { classId: "BaseHero", idFactory: () => "call-parent" });
    const parentGraphs = { BaseHero: addClassMember(emptyGraph(), "function", "Jump", () => "base-fn") };
    const next = removeClassMember(graph, "fn-1", {
      classId: "Hero",
      parentClass: "BaseHero",
      parentOf: (id) => (id === "BaseHero" ? "Actor" : null),
      parentGraphs,
    });
    expect(next.nodes.map((node) => [node.id, node.data.classId])).toEqual([
      ["call-hero", "BaseHero"],
      ["call-parent", "BaseHero"],
    ]);
    // A declared override names its parent even when that parent's graph is not loaded.
    graph.members = [{ ...graph.members![0]!, overrides: { classId: "BaseHero", name: "Jump" } }];
    expect(removeClassMember(graph, "fn-1", { classId: "Hero" }).nodes).toEqual(next.nodes);
  });

  it("drops the Get and Set nodes bound to a removed variable in every graph", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "variable", "Health", () => "var-1");
    graph = addClassMember(graph, "variable", "Armor", () => "var-2");
    const [, health, armor] = graph.members!;
    graph = addVariableAccessNode(graph, health!, "get", { idFactory: () => "get-health" });
    graph = addVariableAccessNode(graph, armor!, "get", { idFactory: () => "get-armor" });
    graph = addVariableAccessNode(graph, health!, "set", {
      functionId: "fn-1",
      idFactory: () => "set-health",
    });
    expect(graph.functionGraphs?.["fn-1"]?.nodes.map((node) => node.id)).toContain("set-health");
    graph = removeClassMember(graph, "var-1");
    expect(graph.members?.map((member) => member.id)).toEqual(["fn-1", "var-2"]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["get-armor"]);
    expect(graph.functionGraphs?.["fn-1"]?.nodes.map((node) => node.id)).toEqual([
      "fn-1-input",
      "fn-1-output",
    ]);
  });

  it("adds a named custom event node for Events +", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "id");
    expect(graph.members).toEqual([
      { id: "id", kind: "event", name: "On Hit", pins: [] },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.type).toBe("flow.event.custom");
    expect(graph.nodes[0]?.data.title).toBe("Event On Hit");
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.pins).toEqual([]);
  });

  it("syncs custom event output pins onto the event node and matching Call nodes", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "call-1",
          type: "flow.event.call",
          position: { x: 200, y: 80 },
          data: {
            title: "Call Event On Hit",
            name: "Event On Hit",
            __nodeType: "flow.event.call",
          },
        },
      ],
    };
    const pins = [{ name: "amount", typeId: "float", direction: "out" as const }];
    graph = patchClassMember(graph, "evt-1", { pins });
    expect(graph.members?.[0]?.pins).toEqual(pins);
    expect(graph.nodes[0]?.data.pins).toEqual(pins);
    expect(graph.nodes[1]?.data.pins).toEqual(pins);
    expect(graph.nodes[1]?.data.name).toBe("On Hit");
    expect(graph.nodes[1]?.data.title).toBe("Call On Hit");
  });

  it("renames a custom event and its local calls without changing links or foreign bindings", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph = addCallEventNode(graph, { name: "On Hit" }, { idFactory: () => "local" });
    graph = addCallEventNode(graph, { name: "On Hit" }, {
      idFactory: () => "foreign", classId: "Other", implicitSelf: false,
    });
    graph.functionGraphs = { "fn-1": { nodes: [], edges: [] } };
    graph = addCallEventNode(graph, { name: "On Hit" }, {
      idFactory: () => "function-call", functionId: "fn-1",
    });
    const functionNode = { id: "evt-1", type: "debug.log", position: { x: 0, y: 0 }, data: { title: "Log" } };
    graph.functionGraphs!["fn-1"]!.nodes.push(functionNode);
    graph.edges = [{ id: "edge", source: "evt-1", target: "local", sourceHandle: "then", targetHandle: "exec" }];
    const next = patchClassMember(graph, "evt-1", { name: "onDamage" });
    expect(next.members?.[0]?.name).toBe("On Damage");
    expect(next.nodes[0]).toMatchObject({ id: "evt-1", data: { name: "On Damage", title: "Event On Damage" } });
    expect(next.nodes[1]).toMatchObject({ id: "local", data: { name: "On Damage", title: "Call On Damage" } });
    expect(next.nodes[2]).toEqual(graph.nodes[2]);
    expect(next.functionGraphs?.["fn-1"]?.nodes[0]?.data.name).toBe("On Damage");
    expect(next.functionGraphs?.["fn-1"]?.nodes[1]).toEqual(functionNode);
    expect(next.edges).toEqual(graph.edges);
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
  });

  it("rejects empty, duplicate and inherited custom event renames", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph = addClassMember(graph, "event", "On Damage", () => "evt-2");
    for (const name of [" ", "onDamage"]) {
      expect(patchClassMember(graph, "evt-1", { name })).toBe(graph);
    }
    graph.nodes[0]!.data.eventQualifier = "Inherited";
    expect(patchClassMember(graph, "evt-1", { name: "Different" })).toBe(graph);
  });

  it("renames legacy node declarations and explicit calls to their class", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    delete graph.members;
    graph = addCallEventNode(graph, { name: "On Hit" }, {
      idFactory: () => "target-call", classId: "Hero", implicitSelf: false,
    });
    const next = renameCustomEvent(graph, "evt-1", "On Damage", "Hero");
    expect(next.nodes.map((node) => node.data.name)).toEqual(["On Damage", "On Damage"]);
    expect(next.members).toBeUndefined();
  });

  it("uses one id for the event member and node so Class tree remove matches", () => {
    let n = 0;
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => `id-${++n}`);
    expect(graph.nodes[0]?.id).toBe(graph.members?.[0]?.id);
    expect(graph.nodes[0]?.id).toBe("id-1");
    const next = removeClassMember(graph, graph.nodes[0]!.id);
    expect(next.nodes).toEqual([]);
    expect(next.members).toEqual([]);
  });

  it("drops the Call Parent node of a removed inherited custom event", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph = addClassMember(graph, "event", "On Land", () => "evt-2");
    for (const [eventNodeId, eventName] of [["evt-1", "On Hit"], ["evt-2", "On Land"]] as const) {
      graph = ensureCallParentForEvent(graph, {
        eventNodeId,
        eventType: "flow.event.custom",
        eventName,
        parentClassId: "BaseHero",
      });
    }
    const next = removeClassMember(graph, "evt-1");
    expect(next.nodes.map((node) => node.id)).toEqual(["evt-2", "call-parent-custom-on-land"]);
    expect(next.edges.map((edge) => edge.source)).toEqual(["evt-2"]);
  });

  it("removes a native event canvas node without dropping the rest of the graph", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = removeClassMember(graph, "begin");
    expect(next.nodes).toEqual([]);
  });

  it("drops event members when the custom event canvas node is gone", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    graph.members = [
      ...(graph.members ?? []),
      { id: "fn-1", kind: "function", name: "Jump" },
    ];
    const next = pruneEventMembersToNodes({
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== "evt-1"),
    });
    expect(next.members).toEqual([
      { id: "fn-1", kind: "function", name: "Jump" },
    ]);
  });

  it("keeps event members that still have a matching canvas node", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    expect(pruneEventMembersToNodes(graph)).toBe(graph);
  });

  it("rejects a Class variable whose name is reserved", () => {
    const graph = addClassMember(
      emptyGraph(),
      "variable",
      "Play Button",
      () => "id",
      undefined,
      { reservedNames: ["Play Button", "Logo"] },
    );
    expect(graph.members).toBeUndefined();
    expect(graph).toEqual(emptyGraph());
  });

  it("adds a variable with a pin type and does not spawn a Get node", () => {
    const graph = addClassMember(emptyGraph(), "variable", "Health", () => "id");
    expect(graph.members?.[0]).toEqual({
      id: "id",
      kind: "variable",
      name: "Health",
      typeId: "float",
    });
    expect(graph.nodes).toEqual([]);
  });

  it("records a function-local variable with functionId and does not spawn a Get node", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "variable", "Temp", () => "loc-1", {
      functionId: "fn-1",
    });
    expect(graph.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loc-1",
          kind: "variable",
          name: "Temp",
          typeId: "float",
          functionId: "fn-1",
        }),
      ]),
    );
    expect(graph.nodes).toEqual([]);
  });

  it("drops function-local variables when the function member is removed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "variable", "Health", () => "var-1");
    graph = addClassMember(graph, "variable", "Temp", () => "loc-1", {
      functionId: "fn-1",
    });
    graph = removeClassMember(graph, "fn-1");
    expect(graph.members).toEqual([
      { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
    ]);
  });

  it("spawns Get and Set nodes onto the event graph for a class variable", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    const member = graph.members![0]!;
    graph = addVariableAccessNode(graph, member, "get", {
      classId: "Hero",
      idFactory: () => "n-get",
    });
    graph = addVariableAccessNode(graph, member, "set", {
      classId: "Hero",
      idFactory: () => "n-set",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "variables.get",
      "variables.set",
    ]);
    expect(graph.nodes[0]?.data).toMatchObject({
      title: "Get Health",
      variableName: "Health",
      variableId: "var-1",
      typeId: "float",
      scope: "member",
      implicitSelf: true,
      classId: "Hero",
    });
    expect(graph.nodes[1]?.data).toMatchObject({
      title: "Set Health",
      variableName: "Health",
      scope: "member",
    });
  });

  it("stamps componentId on Get for a virtual prefab component ref", () => {
    const member = {
      id: "component:text-1",
      kind: "variable" as const,
      name: "3D Text",
      typeId: "object",
      typeClassId: "Text3DComponent",
      componentId: "text-1",
    };
    const graph = addVariableAccessNode(emptyGraph(), member, "get", {
      classId: "Hero",
      idFactory: () => "n-get",
    });
    expect(graph.nodes[0]?.data).toMatchObject({
      title: "Get 3D Text",
      variableName: "3D Text",
      variableId: "component:text-1",
      typeId: "object",
      typeClassId: "Text3DComponent",
      componentId: "text-1",
      implicitSelf: true,
    });
  });

  it("stamps propertyKey and runtime on engine Get and Call nodes", () => {
    const variable = {
      id: "engine:Text3DComponent:var:text",
      kind: "variable" as const,
      name: "Text",
      typeId: "string",
      propertyKey: "text",
    };
    const fn = {
      id: "engine:Text3DComponent:fn:setText",
      kind: "function" as const,
      name: "Set Text",
      runtime: "setText",
      pins: [
        { name: "exec", typeId: "exec", direction: "in" as const },
        { name: "then", typeId: "exec", direction: "out" as const },
        { name: "text", typeId: "string", direction: "in" as const },
      ],
    };
    let graph = addVariableAccessNode(emptyGraph(), variable, "get", {
      classId: "Text3DComponent",
      implicitSelf: false,
      idFactory: () => "n-get",
    });
    graph = addCallFunctionNode(graph, fn, {
      classId: "Text3DComponent",
      implicitSelf: false,
      idFactory: () => "n-call",
    });
    expect(graph.nodes[0]?.data).toMatchObject({
      propertyKey: "text",
      variableName: "Text",
    });
    expect(graph.nodes[1]?.data).toMatchObject({
      functionName: "Set Text",
      runtime: "setText",
    });
  });

  it("treats single object and actor variables as Validated Get types", () => {
    expect(isObjectInstanceVariableType("object")).toBe(true);
    expect(isObjectInstanceVariableType("actor")).toBe(true);
    expect(isObjectInstanceVariableType("bool")).toBe(false);
    expect(isObjectInstanceVariableType("class")).toBe(false);
    expect(isObjectInstanceVariableType("object", "array")).toBe(false);
    expect(isObjectInstanceVariableType("actor", "map")).toBe(false);
  });

  it("spawns Validated Get onto the event graph for an object variable", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Target", () => "var-1", {
      typeId: "object",
      typeClassId: "Actor",
    });
    graph = addVariableAccessNode(graph, graph.members![0]!, "validatedGet", {
      classId: "Hero",
      idFactory: () => "n-validated",
    });
    expect(graph.nodes[0]?.type).toBe("variables.getValidated");
    expect(graph.nodes[0]?.data).toMatchObject({
      title: "Validated Get Target",
      variableName: "Target",
      variableId: "var-1",
      typeId: "object",
      typeClassId: "Actor",
      implicitSelf: true,
      classId: "Hero",
    });
  });

  it("stamps Array/Map container onto spawned and patched Get nodes", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Hits", () => "var-1", {
      typeId: "rotator",
      container: "array",
    });
    graph = addVariableAccessNode(graph, graph.members![0]!, "get", {
      classId: "Hero",
      idFactory: () => "n-get",
    });
    expect(graph.nodes[0]?.data).toMatchObject({
      typeId: "rotator",
      container: "array",
    });
    graph = patchClassMember(graph, "var-1", {
      container: "map",
      keyTypeId: "string",
    });
    expect(graph.nodes[0]?.data).toMatchObject({
      container: "map",
      keyTypeId: "string",
    });
    graph = patchClassMember(graph, "var-1", { container: "single" });
    expect(graph.nodes[0]?.data.container).toBeUndefined();
    expect(graph.nodes[0]?.data.keyTypeId).toBeUndefined();
  });

  it("places Get nodes at an explicit graph position", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    graph = addVariableAccessNode(graph, graph.members![0]!, "get", {
      position: { x: 240, y: 160 },
      idFactory: () => "n-get",
    });
    expect(graph.nodes[0]?.position).toEqual({ x: 240, y: 160 });
  });

  it("spawns a Call Custom Event node at an explicit position", () => {
    let graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1", {
      pins: [{ name: "damage", typeId: "float", direction: "out" }],
    });
    const member = graph.members!.find((entry) => entry.kind === "event")!;
    graph = addCallEventNode(graph, member, {
      position: { x: 120, y: 240 },
      classId: "Hero",
      idFactory: () => "call-evt",
    });
    const node = graph.nodes.find((entry) => entry.id === "call-evt");
    expect(node).toMatchObject({
      type: "flow.event.call",
      position: { x: 120, y: 240 },
      data: {
        title: "Call On Hit",
        name: "On Hit",
        classId: "Hero",
        implicitSelf: true,
        pins: [{ name: "damage", typeId: "float", direction: "out" }],
      },
    });
  });

  it("spawns a Call Function node onto the event graph and a function slice", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    const member = graph.members![0]!;
    graph = addCallFunctionNode(graph, member, {
      position: { x: 40, y: 60 },
      classId: "Hero",
      idFactory: () => "call-fn",
    });
    expect(graph.nodes.find((entry) => entry.id === "call-fn")).toMatchObject({
      type: "functions.call",
      position: { x: 40, y: 60 },
      data: {
        title: "Call Jump",
        functionName: "Jump",
        classId: "Hero",
        implicitSelf: true,
        pins: member.pins,
      },
    });
    graph = addCallFunctionNode(graph, member, {
      functionId: "fn-1",
      position: { x: 8, y: 16 },
      classId: "Hero",
      idFactory: () => "call-local",
    });
    expect(
      graph.functionGraphs?.["fn-1"]?.nodes.find(
        (entry) => entry.id === "call-local",
      ),
    ).toMatchObject({
      type: "functions.call",
      position: { x: 8, y: 16 },
      data: { functionName: "Jump", implicitSelf: true },
    });
  });

  it("asks Get/Set when a variable is dropped on the graph canvas", () => {
    const graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    const result = resolveClassMemberDrop({
      graph,
      memberIds: ["var-1"],
      members: [{ id: "var-1", kind: "variable", name: "Health" }],
      clientX: 180,
      clientY: 90,
      canvas: {
        containsClientPoint: () => true,
        clientToFlow: (x, y) => ({ x: x - 10, y: y - 20 }),
      },
    });
    expect(result).toEqual({
      kind: "choose-access",
      memberIds: ["var-1"],
      position: { x: 170, y: 70 },
      skipped: [],
    });
  });

  it("spawns Call nodes when a function or custom event is dropped on the canvas", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "event", "On Hit", () => "evt-1", {
      pins: [{ name: "damage", typeId: "float", direction: "out" }],
    });
    const canvas = {
      containsClientPoint: () => true,
      clientToFlow: () => ({ x: 64, y: 32 }),
    };
    const callFn = resolveClassMemberDrop({
      graph,
      memberIds: ["fn-1"],
      members: [{ id: "fn-1", kind: "function", name: "Jump", pins: graph.members![0]!.pins }],
      clientX: 1,
      clientY: 1,
      canvas,
      classId: "Hero",
      idFactory: () => "dropped-fn",
    });
    expect(callFn.kind).toBe("spawn");
    if (callFn.kind !== "spawn") return;
    expect(callFn.graph.nodes.find((node) => node.id === "dropped-fn")).toMatchObject({
      type: "functions.call",
      position: { x: 64, y: 32 },
      data: { functionName: "Jump", classId: "Hero" },
    });

    const callEvt = resolveClassMemberDrop({
      graph,
      memberIds: ["evt-1"],
      members: [
        {
          id: "evt-1",
          kind: "event",
          name: "On Hit",
          eventType: "flow.event.custom",
        },
      ],
      clientX: 1,
      clientY: 1,
      canvas,
      classId: "Hero",
      idFactory: () => "dropped-evt",
    });
    expect(callEvt.kind).toBe("spawn");
    if (callEvt.kind !== "spawn") return;
    expect(callEvt.graph.nodes.find((node) => node.id === "dropped-evt")).toMatchObject({
      type: "flow.event.call",
      position: { x: 64, y: 32 },
      data: { name: "On Hit", classId: "Hero" },
    });
  });

  it("ignores section rows, native events, and drops outside the canvas", () => {
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => "evt-1");
    const members = [
      { id: "section-events", kind: "event" as const, name: "Events" },
      {
        id: "native:flow.event.beginPlay",
        kind: "event" as const,
        name: "Event Begin Play",
        eventType: "flow.event.beginPlay",
      },
    ];
    expect(
      resolveClassMemberDrop({
        graph,
        memberIds: ["section-events"],
        members,
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => true, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
    expect(
      resolveClassMemberDrop({
        graph,
        memberIds: ["native:flow.event.beginPlay"],
        members,
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => true, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
    expect(
      resolveClassMemberDrop({
        graph,
        memberIds: ["evt-1"],
        members: [
          { id: "evt-1", kind: "event", name: "On Hit", eventType: "flow.event.custom" },
        ],
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => false, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
  });

  describe("dropping several rows at once", () => {
    const canvas = {
      containsClientPoint: () => true,
      clientToFlow: () => ({ x: 64, y: 32 }),
    };
    const pinsOf = (count: number) => [
      ...Array.from({ length: count }, (_, index) => ({
        name: `In${index}`,
        typeId: "float",
        direction: "in" as const,
      })),
    ];

    function classWithMembers(): SerializedGraph {
      let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-jump");
      graph = addClassMember(graph, "function", "Cast", () => "fn-cast", { pins: pinsOf(6) });
      graph = addClassMember(graph, "event", "On Hit", () => "evt-hit");
      graph = addClassMember(graph, "variable", "Health", () => "var-health", { typeId: "float" });
      graph = addClassMember(graph, "variable", "Pawn", () => "var-pawn", { typeId: "actor", typeClassId: "Actor" });
      return graph;
    }
    const rows = [
      { id: "fn-jump", kind: "function" as const, name: "Jump" },
      { id: "fn-cast", kind: "function" as const, name: "Cast" },
      { id: "evt-hit", kind: "event" as const, name: "On Hit", eventType: "flow.event.custom" },
      { id: "var-health", kind: "variable" as const, name: "Health", typeId: "float" },
      { id: "var-pawn", kind: "variable" as const, name: "Pawn", typeId: "actor", typeClassId: "Actor" },
      { id: "native:flow.event.beginPlay", kind: "event" as const, name: "Event Begin Play", eventType: "flow.event.beginPlay" },
      { id: "if-1", kind: "interface" as const, name: "Damageable" },
    ];
    /** The nodes a drop added: the Class's own event node is not one of them. */
    const added = (graph: SerializedGraph) => graph.nodes.filter((node) => node.type !== "flow.event.custom");
    const drop = (memberIds: string[], extra: Partial<Parameters<typeof resolveClassMemberDrop>[0]> = {}) =>
      resolveClassMemberDrop({
        graph: classWithMembers(),
        memberIds,
        members: rows,
        clientX: 1,
        clientY: 1,
        canvas,
        classId: "Hero",
        idFactory: (() => {
          let count = 0;
          return () => `drop-${++count}`;
        })(),
        ...extra,
      });

    it("spawns every call at once in one stack from the drop point, tall nodes taking more room", () => {
      const result = drop(["fn-jump", "fn-cast", "evt-hit", "fn-jump"]);
      expect(result.kind).toBe("spawn");
      if (result.kind !== "spawn") return;
      const dropped = added(result.graph);
      expect(dropped.map((node) => [node.type, node.data.functionName ?? node.data.name])).toEqual([
        ["functions.call", "Jump"],
        ["functions.call", "Cast"],
        ["flow.event.call", "On Hit"],
      ]);
      expect(dropped[0]!.position).toEqual({ x: 64, y: 32 });
      expect(dropped.every((node) => node.position.x === 64)).toBe(true);
      const gaps = [
        dropped[1]!.position.y - dropped[0]!.position.y,
        dropped[2]!.position.y - dropped[1]!.position.y,
      ];
      // No node starts inside the one above it, and six more inputs make Cast taller than Jump.
      expect(gaps[0]).toBeGreaterThanOrEqual(120);
      expect(gaps[1]).toBeGreaterThan(gaps[0]!);
      expect(result.skipped).toEqual([]);
    });

    it("places the stack in the open function graph", () => {
      const result = drop(["fn-jump", "evt-hit"], { functionId: "fn-jump" });
      expect(result.kind).toBe("spawn");
      if (result.kind !== "spawn") return;
      expect(added(result.graph)).toEqual([]);
      expect(result.graph.functionGraphs!["fn-jump"]!.nodes.slice(2).map((node) => node.type)).toEqual([
        "functions.call",
        "flow.event.call",
      ]);
    });

    it("skips the rows that cannot drop and reports them by name", () => {
      const result = drop(["fn-jump", "native:flow.event.beginPlay", "if-1", "section-events"]);
      expect(result.kind).toBe("spawn");
      if (result.kind !== "spawn") return;
      expect(added(result.graph).map((node) => node.data.functionName)).toEqual(["Jump"]);
      expect(result.skipped).toEqual(["Event Begin Play", "Damageable"]);
      expect(drop(["native:flow.event.beginPlay", "if-1"]).kind).toBe("ignore");
    });

    it("asks Get / Set once for the variables among them and keeps the order of the rest", () => {
      const result = drop(["var-health", "fn-jump", "var-pawn", "if-1"]);
      expect(result).toEqual({
        kind: "choose-access",
        memberIds: ["var-health", "fn-jump", "var-pawn"],
        position: { x: 64, y: 32 },
        skipped: ["Damageable"],
      });
    });

    it.each([
      ["get", ["Get Health", "Call Jump", "Get Pawn"], []],
      ["set", ["Set Health", "Call Jump", "Set Pawn"], []],
      ["validatedGet", ["Call Jump", "Validated Get Pawn"], ["Health"]],
    ] as const)("places every row with the chosen %s access, skipping variables it cannot use", (access, titles, skipped) => {
      const completed = completeClassMemberDrop({
        graph: classWithMembers(),
        memberIds: ["var-health", "fn-jump", "var-pawn"],
        members: rows,
        position: { x: 64, y: 32 },
        access,
        classId: "Hero",
      });
      expect(added(completed.graph).map((node) => node.data.title)).toEqual(titles);
      expect(added(completed.graph)[0]!.position).toEqual({ x: 64, y: 32 });
      expect(completed.skipped).toEqual(skipped);
    });

    it("stacks a Get as a compact pill, closer than a full node", () => {
      const completed = completeClassMemberDrop({
        graph: classWithMembers(),
        memberIds: ["fn-jump", "var-health", "var-pawn"],
        members: rows,
        position: { x: 0, y: 0 },
        access: "get",
      });
      const [first, second, third] = added(completed.graph).map((node) => node.position.y);
      expect(third! - second!).toBeLessThan(second! - first!);
    });

    it("never lets a component variable be set", () => {
      const completed = completeClassMemberDrop({
        graph: classWithMembers(),
        memberIds: ["var-health", "comp-mesh"],
        members: [...rows, { id: "comp-mesh", kind: "variable", name: "Mesh", typeId: "object", componentId: "c-1" }],
        position: { x: 0, y: 0 },
        access: "set",
      });
      expect(added(completed.graph).map((node) => node.data.title)).toEqual(["Set Health"]);
      expect(completed.skipped).toEqual(["Mesh"]);
    });
  });

  it("copies typeClassId onto spawned Get nodes and synced access nodes", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Target", () => "var-1", {
      typeId: "object",
      typeClassId: "Hero",
    });
    graph = addVariableAccessNode(graph, graph.members![0]!, "get", {
      idFactory: () => "n-get",
    });
    expect(graph.nodes[0]?.data).toMatchObject({
      typeId: "object",
      typeClassId: "Hero",
    });
    graph = patchClassMember(graph, "var-1", { typeClassId: "Actor" });
    expect(graph.nodes[0]?.data).toMatchObject({
      typeId: "object",
      typeClassId: "Actor",
    });
  });

  it("spawns Get onto the active function graph for a local variable", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "variable", "Temp", () => "loc-1", {
      functionId: "fn-1",
    });
    const member = graph.members!.find((entry) => entry.id === "loc-1")!;
    graph = addVariableAccessNode(graph, member, "get", {
      functionId: "fn-1",
      idFactory: () => "n-get",
    });
    expect(graph.nodes).toEqual([]);
    expect(
      graph.functionGraphs?.["fn-1"]?.nodes.some(
        (node) => node.id === "n-get" && node.type === "variables.get",
      ),
    ).toBe(true);
    expect(
      graph.functionGraphs?.["fn-1"]?.nodes.find((node) => node.id === "n-get")
        ?.data,
    ).toMatchObject({
      scope: "local",
      functionId: "fn-1",
      variableName: "Temp",
    });
  });

  it("syncs Get and Set nodes when a variable is renamed or retyped", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    const member = graph.members![0]!;
    graph = addVariableAccessNode(graph, member, "get", {
      idFactory: () => "n-get",
    });
    graph = {
      ...graph,
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "fn-get",
              type: "variables.get",
              position: { x: 0, y: 0 },
              data: {
                variableId: "var-1",
                variableName: "Health",
                typeId: "float",
                title: "Get Health",
              },
            },
          ],
          edges: [],
        },
      },
    };
    graph = patchClassMember(graph, "var-1", { name: "Armor", typeId: "int" });
    expect(graph.nodes[0]?.data).toMatchObject({
      variableName: "Armor",
      typeId: "int",
      title: "Get Armor",
    });
    expect(graph.functionGraphs?.["fn-1"]?.nodes[0]?.data).toMatchObject({
      variableName: "Armor",
      typeId: "int",
      title: "Get Armor",
    });
  });

  it("patches and removes a declared member", () => {
    let graph = addClassMember(emptyGraph(), "variable", "Health", () => "var-1");
    graph = patchClassMember(graph, "var-1", { typeId: "bool", defaultValue: "true" });
    expect(graph.members?.[0]).toMatchObject({
      typeId: "bool",
      defaultValue: "true",
    });
    graph = removeClassMember(graph, "var-1");
    expect(graph.members).toEqual([]);
  });

  it("syncs function Input/Output node pin lists when the signature changes", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    const stalePins = [
      {
        id: "exec",
        name: "exec",
        kind: "exec" as const,
        direction: "out" as const,
        type: { kind: "exec" as const },
      },
    ];
    const seeded = graph.functionGraphs?.["fn-1"];
    graph = {
      ...graph,
      functionGraphs: {
        "fn-1": {
          nodes: (seeded?.nodes ?? []).map((node) => ({
            ...node,
            data: { ...node.data, __pins: stalePins },
          })),
          edges: seeded?.edges ?? [],
        },
      },
    };
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" as const },
      { name: "height", typeId: "float", direction: "in" as const },
      { name: "then", typeId: "exec", direction: "out" as const },
    ];
    graph = patchClassMember(graph, "fn-1", { pins });
    expect(graph.members?.[0]?.pins).toEqual(pins);
    const slice = graph.functionGraphs?.["fn-1"];
    expect(slice?.nodes.map((node) => node.data.pins)).toEqual([pins, pins]);
    expect(slice?.nodes.map((node) => node.data.__pins)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("syncs function signature pins onto matching Call nodes in every graph", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "function", "Land", () => "fn-2");
    const call = (id: string) => ({
      id,
      type: "functions.call",
      position: { x: 200, y: 80 },
      data: {
        title: "Call Jump",
        functionName: "Jump",
        classId: "Hero",
        implicitSelf: true,
        __nodeType: "functions.call",
      },
    });
    const land = graph.functionGraphs!["fn-2"]!;
    graph = {
      ...graph,
      nodes: [call("call-1")],
      functionGraphs: {
        ...graph.functionGraphs,
        "fn-2": { ...land, nodes: [...land.nodes, call("call-2")] },
      },
    };
    const pins = [
      { name: "height", typeId: "float", direction: "in" as const },
      { name: "exec", typeId: "exec", direction: "in" as const },
      { name: "then", typeId: "exec", direction: "out" as const },
    ];
    graph = patchClassMember(graph, "fn-1", { pins }, "Hero");
    const landCall = graph.functionGraphs?.["fn-2"]?.nodes.find(
      (node) => node.id === "call-2",
    );
    for (const node of [graph.nodes[0], landCall]) {
      expect(node?.data.pins).toEqual(pins);
      expect(node?.data.__pins).toBeUndefined();
    }
  });

  it("retargets self Call Function nodes in every graph when a function is renamed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = addClassMember(graph, "function", "Land", () => "fn-2");
    graph = addCallFunctionNode(graph, graph.members![0]!, { idFactory: () => "self-call", classId: "Hero" });
    graph = addCallFunctionNode(graph, graph.members![0]!, { idFactory: () => "nested-call", functionId: "fn-2" });
    graph = addCallFunctionNode(graph, graph.members![0]!, {
      idFactory: () => "target-call", classId: "Enemy", implicitSelf: false,
    });
    graph = addCallFunctionNode(graph, graph.members![0]!, { idFactory: () => "library-call", classId: "MathLib" });
    graph = patchClassMember(graph, "fn-1", { name: "Leap" }, "Hero");
    const nested = graph.functionGraphs?.["fn-2"]?.nodes.find((node) => node.id === "nested-call");
    for (const node of [graph.nodes.find((entry) => entry.id === "self-call"), nested]) {
      expect(node?.data).toMatchObject({ functionName: "Leap", title: "Call Leap" });
    }
    for (const id of ["target-call", "library-call"]) {
      expect(graph.nodes.find((node) => node.id === id)?.data).toMatchObject({
        functionName: "Jump", title: "Call Jump",
      });
    }
  });
});

describe("blueprintSectionsForClass", () => {
  it("lists Functions, Variables, Events, and Interfaces for Actor and BObject", () => {
    expect(blueprintSectionsForClass({ parentClass: "Actor" }).map((s) => s.id)).toEqual([
      "functions",
      "variables",
      "events",
      "interfaces",
    ]);
    expect(
      blueprintSectionsForClass({ parentClass: "BObject" }).map((s) => s.id),
    ).toEqual(["functions", "variables", "events", "interfaces"]);
    expect(
      blueprintSectionsForClass({
        parentClass: "Actor",
        activeFunctionId: "fn-1",
      }).map((s) => s.id),
    ).toEqual([
      "functions",
      "variables",
      "local-variables",
      "events",
      "interfaces",
    ]);
  });

  it("lists Functions only for FunctionLibrary, plus Local Variables when a function is open", () => {
    expect(
      blueprintSectionsForClass({ parentClass: "FunctionLibrary" }).map(
        (s) => s.id,
      ),
    ).toEqual(["functions"]);
    expect(
      blueprintSectionsForClass({
        parentClass: "EditorFunctionLibrary",
        parentOf: (id) =>
          id === "EditorFunctionLibrary" ? "FunctionLibrary" : "BObject",
        activeFunctionId: "fn-1",
      }).map((s) => s.id),
    ).toEqual(["functions", "local-variables"]);
  });
});

describe("classAllowsMemberKind", () => {
  it("allows every member kind on Actor", () => {
    expect(classAllowsMemberKind("function", { parentClass: "Actor" })).toBe(
      true,
    );
    expect(classAllowsMemberKind("variable", { parentClass: "Actor" })).toBe(
      true,
    );
    expect(classAllowsMemberKind("event", { parentClass: "Actor" })).toBe(true);
    expect(classAllowsMemberKind("interface", { parentClass: "Actor" })).toBe(
      true,
    );
  });

  it("blocks event, variable, and interface members on FunctionLibrary hosts", () => {
    expect(
      classAllowsMemberKind("function", { parentClass: "FunctionLibrary" }),
    ).toBe(true);
    expect(
      classAllowsMemberKind("variable", { parentClass: "FunctionLibrary" }),
    ).toBe(false);
    expect(
      classAllowsMemberKind("event", { parentClass: "FunctionLibrary" }),
    ).toBe(false);
    expect(
      classAllowsMemberKind("interface", { parentClass: "FunctionLibrary" }),
    ).toBe(false);
    expect(
      classAllowsMemberKind("variable", {
        parentClass: "FunctionLibrary",
        local: true,
      }),
    ).toBe(true);
    expect(
      classAllowsMemberKind("event", {
        parentClass: "EditorFunctionLibrary",
        parentOf: (id) =>
          id === "EditorFunctionLibrary" ? "FunctionLibrary" : "BObject",
      }),
    ).toBe(false);
  });
});

describe("functionLibraryShowsEventGraphEmpty", () => {
  it("shows the empty Event Graph only for FunctionLibrary hosts without a function open", () => {
    expect(
      functionLibraryShowsEventGraphEmpty({ parentClass: "FunctionLibrary" }),
    ).toBe(true);
    expect(
      functionLibraryShowsEventGraphEmpty({
        parentClass: "EditorFunctionLibrary",
        parentOf: (id) =>
          id === "EditorFunctionLibrary" ? "FunctionLibrary" : "BObject",
      }),
    ).toBe(true);
    expect(
      functionLibraryShowsEventGraphEmpty({
        parentClass: "FunctionLibrary",
        activeFunctionId: "fn-1",
      }),
    ).toBe(false);
    expect(
      functionLibraryShowsEventGraphEmpty({ parentClass: "Actor" }),
    ).toBe(false);
  });
});

describe("ensureEventNodeOnGraph Call Parent", () => {
  it("adds Call Parent and default wires when a parent class is provided", () => {
    let graph = emptyGraph();
    graph = ensureEventNodeOnGraph(graph, "flow.event.beginPlay", {
      parentClassId: "HeroBase",
      idFactory: () => "evt-1",
    });
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "flow.event.beginPlay",
      "flow.event.callParent",
    ]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "evt-1",
          target: "call-parent-flow-event-beginPlay",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        }),
      ]),
    );
  });

  it("does not duplicate Call Parent on a second ensure", () => {
    let graph = ensureEventNodeOnGraph(emptyGraph(), "flow.event.tick", {
      parentClassId: "Actor",
    });
    const once = graph.nodes.filter(
      (node) => node.type === "flow.event.callParent",
    ).length;
    graph = ensureEventNodeOnGraph(graph, "flow.event.tick", {
      parentClassId: "Actor",
    });
    expect(
      graph.nodes.filter((node) => node.type === "flow.event.callParent"),
    ).toHaveLength(once);
  });

  it("wires a catalog event's arguments to Call Parent by pin id", () => {
    const graph = ensureEventNodeOnGraph(emptyGraph(), "flow.event.hit", {
      parentClassId: "Actor",
      idFactory: () => "evt-hit",
      pins: [{ name: "Hit Result", typeId: "struct", direction: "out" }],
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: "evt-hit",
      target: "call-parent-flow-event-hit",
      sourceHandle: "hitResult",
      targetHandle: "hitResult",
    }));
    expect(graph.edges.some((edge) => edge.sourceHandle === "Hit Result")).toBe(false);
  });

  it("does not rewire when the user already moved Call Parent later", () => {
    let graph = ensureEventNodeOnGraph(emptyGraph(), "flow.event.beginPlay", {
      parentClassId: "Actor",
      idFactory: () => "evt-1",
    });
    const callId = "call-parent-flow-event-beginPlay";
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "log-1",
          type: "debug.log",
          position: { x: 200, y: 80 },
          data: {},
        },
      ],
      edges: [
        {
          id: "e:evt:log",
          source: "evt-1",
          target: "log-1",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
        {
          id: "e:log:cp",
          source: "log-1",
          target: callId,
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    graph = ensureCallParentForEvent(graph, {
      eventNodeId: "evt-1",
      eventType: "flow.event.beginPlay",
      parentClassId: "Actor",
    });
    expect(
      graph.edges.some(
        (edge) =>
          edge.source === "evt-1" &&
          edge.target === callId &&
          edge.sourceHandle === "execOut",
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) => edge.source === "log-1" && edge.target === callId,
      ),
    ).toBe(true);
  });
});

describe("droppedRowsNotice", () => {
  it("says nothing when every row dropped", () => {
    expect(droppedRowsNotice([], [])).toBeNull();
  });

  it("names the rows that cannot go on a graph and the variables the chosen node refuses", () => {
    expect(droppedRowsNotice(["Event Begin Play", "Damageable"])).toBe(
      "Event Begin Play and Damageable can't be added to a graph.",
    );
    expect(droppedRowsNotice([], ["Mesh"], "set")).toBe("Mesh can't be added as Set.");
    expect(droppedRowsNotice(["Damageable"], ["Health"], "validatedGet")).toBe(
      "Damageable can't be added to a graph. Health can't be added as Validated Get.",
    );
  });
});

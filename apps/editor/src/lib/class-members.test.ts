import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  addCallEventNode,
  addCallFunctionNode,
  addClassMember,
  addVariableAccessNode,
  blueprintSectionsForClass,
  classAllowsMemberKind,
  ensureCallParentForEvent,
  ensureEventNodeOnGraph,
  functionLibraryShowsEventGraphEmpty,
  memberNamePromptCopy,
  patchClassMember,
  removeClassMember,
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

  it("drops the function graph when the function member is removed", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = removeClassMember(graph, "fn-1");
    expect(graph.members).toEqual([]);
    expect(graph.functionGraphs?.["fn-1"]).toBeUndefined();
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

  it("uses one id for the event member and node so Class tree remove matches", () => {
    let n = 0;
    const graph = addClassMember(emptyGraph(), "event", "On Hit", () => `id-${++n}`);
    expect(graph.nodes[0]?.id).toBe(graph.members?.[0]?.id);
    expect(graph.nodes[0]?.id).toBe("id-1");
    const next = removeClassMember(graph, graph.nodes[0]!.id);
    expect(next.nodes).toEqual([]);
    expect(next.members).toEqual([]);
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

  it("Title Cases typed event names and prefixes Event on the node", () => {
    const graph = addClassMember(emptyGraph(), "event", "on hit", () => "id");
    expect(graph.members?.[0]?.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.name).toBe("On Hit");
    expect(graph.nodes[0]?.data.title).toBe("Event On Hit");
  });

  it("does not double-prefix Event when the typed name already has it", () => {
    const graph = addClassMember(
      emptyGraph(),
      "event",
      "Event beginPlay",
      () => "id",
    );
    expect(graph.members?.[0]?.name).toBe("Begin Play");
    expect(graph.nodes[0]?.data.title).toBe("Event Begin Play");
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
      memberId: "var-1",
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
      memberId: "var-1",
      position: { x: 170, y: 70 },
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
      memberId: "fn-1",
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
      memberId: "evt-1",
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
        memberId: "section-events",
        members,
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => true, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
    expect(
      resolveClassMemberDrop({
        graph,
        memberId: "native:flow.event.beginPlay",
        members,
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => true, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
    expect(
      resolveClassMemberDrop({
        graph,
        memberId: "evt-1",
        members: [
          { id: "evt-1", kind: "event", name: "On Hit", eventType: "flow.event.custom" },
        ],
        clientX: 0,
        clientY: 0,
        canvas: { containsClientPoint: () => false, clientToFlow: () => ({ x: 0, y: 0 }) },
      }).kind,
    ).toBe("ignore");
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

  it("syncs function signature pins onto matching Call nodes", () => {
    let graph = addClassMember(emptyGraph(), "function", "Jump", () => "fn-1");
    graph = {
      ...graph,
      nodes: [
        {
          id: "call-1",
          type: "functions.call",
          position: { x: 200, y: 80 },
          data: {
            title: "Call Jump",
            functionName: "Jump",
            classId: "Hero",
            implicitSelf: true,
            __nodeType: "functions.call",
          },
        },
      ],
    };
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" as const },
      { name: "height", typeId: "float", direction: "in" as const },
      { name: "then", typeId: "exec", direction: "out" as const },
    ];
    graph = patchClassMember(graph, "fn-1", { pins });
    expect(graph.nodes[0]?.data.pins).toEqual(pins);
    expect(graph.nodes[0]?.data.__pins).toBeUndefined();
  });
});

describe("memberNamePromptCopy", () => {
  it("returns Title Case titles and labels for each member kind", () => {
    expect(memberNamePromptCopy("function")).toEqual({
      title: "Add Function",
      label: "Function Name",
    });
    expect(memberNamePromptCopy("variable").title).toBe("Add Variable");
    expect(memberNamePromptCopy("variable", { local: true }).title).toBe(
      "Add Local Variable",
    );
    expect(memberNamePromptCopy("event").label).toBe("Event Name");
    expect(memberNamePromptCopy("interface").title).toBe("Add Interface");
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

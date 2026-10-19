import { describe, expect, it } from "vitest";
import type { GraphClassMember, GraphClassMemberPin, SerializedComponent, SerializedGraph } from "@babylonslate/core";
import {
  copyClassMembers,
  pasteClassMembers,
  skippedMembersNotice,
  type ClassMemberClipboard,
  type ClassMemberCopyRow,
} from "./class-member-clipboard";

type Node = SerializedGraph["nodes"][number];

const FUNCTION_PINS: GraphClassMemberPin[] = [
  { name: "exec", typeId: "exec", direction: "in" },
  { name: "then", typeId: "exec", direction: "out" },
  { name: "Amount", typeId: "float", direction: "in" },
];
const EVENT_PINS: GraphClassMemberPin[] = [{ name: "Amount", typeId: "float", direction: "out" }];

function sequence(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}${++count}`;
}

function node(id: string, type: string, data: Record<string, unknown> = {}, x = 0, y = 0): Node {
  return { id, type, position: { x, y }, data };
}

function variableNode(
  id: string,
  type: "variables.get" | "variables.set",
  variable: GraphClassMember,
  extra: Record<string, unknown> = {},
): Node {
  return node(id, type, {
    title: `${type === "variables.set" ? "Set" : "Get"} ${variable.name}`,
    variableName: variable.name,
    variableId: variable.id,
    typeId: variable.typeId,
    scope: variable.functionId ? "local" : "member",
    implicitSelf: true,
    classId: "Hero",
    ...(variable.functionId ? { functionId: variable.functionId } : {}),
    ...extra,
  });
}

const HEALTH: GraphClassMember = {
  id: "var-health",
  kind: "variable",
  name: "Health",
  typeId: "float",
  defaultValue: 100,
  category: "Stats|Core",
};
const MANA: GraphClassMember = { id: "var-mana", kind: "variable", name: "Mana", typeId: "int", defaultValue: 5 };
const CUE: GraphClassMember = {
  id: "var-cue",
  kind: "variable",
  name: "Cue",
  typeId: "asset",
  typeClassId: "Audio",
  loading: "hard",
  defaultValue: "audio-1",
};
const SCORES: GraphClassMember = {
  id: "var-scores",
  kind: "variable",
  name: "Scores",
  typeId: "int",
  container: "map",
  keyTypeId: "string",
  defaultValue: [{ key: "a", value: 1 }],
};
const TEMP: GraphClassMember = {
  id: "var-temp",
  kind: "variable",
  name: "Temp",
  typeId: "float",
  functionId: "fn-heal",
  defaultValue: 2,
};
const HEAL: GraphClassMember = {
  id: "fn-heal",
  kind: "function",
  name: "Heal",
  pins: FUNCTION_PINS,
  category: "Combat",
  overridable: true,
  implementsInterface: { assetGuid: "iface-1", methodName: "Heal" },
  overrides: { classId: "Base", name: "Heal" },
};
const HELPER: GraphClassMember = { id: "fn-helper", kind: "function", name: "Helper", pins: FUNCTION_PINS };
const ON_HEALED_NODE = node(
  "evt-healed",
  "flow.event.custom",
  { title: "Event On Healed", name: "On Healed", pins: EVENT_PINS, __nodeType: "flow.event.custom" },
  80,
  200,
);
const BEGIN_PLAY_NODE = node(
  "evt-begin",
  "flow.event.beginPlay",
  { title: "Event Begin Play", __nodeType: "flow.event.beginPlay" },
  80,
  80,
);

const MESH: SerializedComponent = {
  id: "prefab-mesh",
  classId: "MeshComponent",
  properties: { shape: "box", castShadows: true },
  parentId: null,
  transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
};

function healBody(): { nodes: Node[]; edges: SerializedGraph["edges"] } {
  return {
    nodes: [
      node("fn-heal-input", "flow.function.input", { pins: FUNCTION_PINS, __protected: true }, 80, 120),
      node("fn-heal-output", "flow.function.output", { pins: FUNCTION_PINS, __protected: true }, 600, 120),
      variableNode("get-health", "variables.get", HEALTH),
      variableNode("set-mana", "variables.set", MANA),
      variableNode("get-temp", "variables.get", TEMP),
      node("call-helper", "functions.call", {
        title: "Call Helper",
        functionName: "Helper",
        classId: "Hero",
        implicitSelf: true,
        pins: FUNCTION_PINS,
      }),
      node("call-self", "functions.call", {
        title: "Call Heal",
        functionName: "Heal",
        classId: "Hero",
        implicitSelf: true,
        pins: FUNCTION_PINS,
      }),
      node("call-event", "flow.event.call", {
        title: "Call On Healed",
        name: "On Healed",
        classId: "Hero",
        implicitSelf: true,
        pins: EVENT_PINS,
      }),
    ],
    edges: [
      { id: "e1", source: "fn-heal-input", target: "set-mana", sourceHandle: "exec", targetHandle: "execIn" },
      { id: "e2", source: "get-health", target: "set-mana", sourceHandle: "value", targetHandle: "value" },
      { id: "e3", source: "set-mana", target: "fn-heal-output", sourceHandle: "execOut", targetHandle: "then" },
    ],
  };
}

/** The source Class: variables, a function with a local and a body, an event and Begin Play. */
function heroGraph(): SerializedGraph {
  return structuredClone<SerializedGraph>({
    nodes: [BEGIN_PLAY_NODE, ON_HEALED_NODE],
    edges: [],
    members: [
      HEALTH,
      MANA,
      CUE,
      SCORES,
      HEAL,
      TEMP,
      HELPER,
      { id: "evt-healed", kind: "event", name: "On Healed", pins: EVENT_PINS },
    ],
    functionGraphs: {
      "fn-heal": healBody(),
      "fn-helper": { nodes: [], edges: [] },
    },
  });
}

function row(
  graph: SerializedGraph,
  kind: ClassMemberCopyRow["kind"],
  name: string,
): ClassMemberCopyRow {
  const member = graph.members?.find((entry) => entry.kind === kind && entry.name === name);
  if (member) return { id: member.id, kind, name };
  const eventNode = graph.nodes.find((entry) => entry.data.name === name || entry.data.title === name);
  return { id: eventNode!.id, kind, name };
}

function copy(rows: ClassMemberCopyRow[], graph = heroGraph(), classId = "Hero"): ClassMemberClipboard {
  const clip = copyClassMembers(rows, { graph, classId });
  expect(clip).not.toBeNull();
  return clip!;
}

const emptyTarget = (members: GraphClassMember[] = [], nodes: Node[] = []): SerializedGraph => ({
  nodes,
  edges: [],
  members,
});

function namesOf(graph: SerializedGraph, kind: GraphClassMember["kind"]): string[] {
  return (graph.members ?? []).filter((member) => member.kind === kind).map((member) => member.name);
}

function taken(graph: SerializedGraph) {
  return {
    variable: namesOf(graph, "variable"),
    function: namesOf(graph, "function"),
  };
}

function paste(
  clipboard: ClassMemberClipboard,
  graph: SerializedGraph,
  options: Partial<Parameters<typeof pasteClassMembers>[0]> = {},
) {
  return pasteClassMembers({
    graph,
    clipboard,
    classId: "Enemy",
    takenNames: taken(graph),
    idFactory: sequence("new-"),
    ...options,
  });
}

describe("copyClassMembers", () => {
  it("snapshots full variable definitions, a function with its locals and graph, and an event node", () => {
    const hero = heroGraph();
    const clip = copy(
      [
        row(hero, "variable", "Health"),
        row(hero, "variable", "Cue"),
        row(hero, "variable", "Scores"),
        row(hero, "function", "Heal"),
        { id: "evt-healed", kind: "event", name: "On Healed" },
        { id: "evt-begin", kind: "event", name: "Event Begin Play" },
      ],
      hero,
    );

    expect(clip.variables.map((entry) => entry.member)).toEqual([HEALTH, CUE, SCORES]);
    expect(clip.functions).toHaveLength(1);
    expect(clip.functions[0]!.member).toEqual(HEAL);
    expect(clip.functions[0]!.locals).toEqual([TEMP]);
    expect(clip.functions[0]!.nodes.map((entry) => entry.id)).toEqual(
      healBody().nodes.map((entry) => entry.id),
    );
    expect(clip.functions[0]!.edges).toHaveLength(3);
    expect(clip.events.map((entry) => [entry.node.id, entry.bound])).toEqual([
      ["evt-healed", false],
      ["evt-begin", false],
    ]);
  });

  it("is a snapshot: editing the source Class afterwards does not change it", () => {
    const hero = heroGraph();
    const clip = copy([row(hero, "variable", "Health"), row(hero, "function", "Heal")], hero);
    hero.members![0]!.name = "Renamed";
    hero.functionGraphs!["fn-heal"]!.nodes.length = 0;
    expect(clip.variables[0]!.member.name).toBe("Health");
    expect(clip.functions[0]!.nodes).toHaveLength(8);
  });

  it.each([
    ["a Script Interface", { id: "if-1", kind: "interface", name: "Damageable" } as ClassMemberCopyRow],
    ["a member that no longer exists", { id: "gone", kind: "variable", name: "Gone" } as ClassMemberCopyRow],
    ["a local variable that no longer exists", { id: "gone", kind: "variable", name: "Gone", functionId: "fn-heal" } as ClassMemberCopyRow],
    ["a component that no longer exists", { id: "component:gone", kind: "variable", name: "Mesh", componentId: "gone" } as ClassMemberCopyRow],
  ])("offers no snapshot for a selection that includes %s", (_name, bad) => {
    const hero = heroGraph();
    expect(copyClassMembers([row(hero, "variable", "Health"), bad], { graph: hero, classId: "Hero" })).toBeNull();
    expect(copyClassMembers([], { graph: hero, classId: "Hero" })).toBeNull();
  });

  it("copies a local variable alone or among other members, and a component variable with its component", () => {
    const hero = heroGraph();
    hero.components = [MESH, { ...MESH, id: "prefab-component-2", name: "Arm", parentId: "prefab-mesh" }];
    const local: ClassMemberCopyRow = { id: "var-temp", kind: "variable", name: "Temp", functionId: "fn-heal" };
    expect(copy([local], hero).variables).toEqual([{ member: TEMP, sourceClassId: "Hero" }]);

    const clip = copy(
      [row(hero, "variable", "Health"), local, { id: "component:prefab-component-2", kind: "variable", name: "Arm", componentId: "prefab-component-2" }],
      hero,
    );
    expect(clip.variables.map((entry) => entry.member.name)).toEqual(["Health", "Temp", "Arm"]);
    expect(clip.variables[2]).toMatchObject({
      member: { id: "component:prefab-component-2", typeId: "object", typeClassId: "MeshComponent", componentId: "prefab-component-2" },
      component: hero.components![1],
    });
  });

  it("reads an inherited component from the parent, unless the Class overrides it", () => {
    const parent: SerializedGraph = { nodes: [], edges: [], components: [MESH] };
    const row: ClassMemberCopyRow = {
      id: "component:prefab-mesh",
      kind: "variable",
      name: "Mesh",
      componentId: "prefab-mesh",
      inheritedFrom: "Base",
    };
    const inherited = copyClassMembers([row], { graph: emptyTarget(), classId: "Child", parentGraphs: { Base: parent } });
    expect(inherited?.variables[0]?.component).toEqual(MESH);
    const overridden = copyClassMembers([row], {
      graph: { ...emptyTarget(), components: [{ ...MESH, properties: { shape: "sphere" } }] },
      classId: "Child",
      parentGraphs: { Base: parent },
    });
    expect(overridden?.variables[0]?.component?.properties).toEqual({ shape: "sphere" });
  });

  it("reads a row inherited from a parent Class out of the parent's graph by name", () => {
    const parent: SerializedGraph = { nodes: [], edges: [], members: [{ ...HEALTH, id: "parent-health" }] };
    const clip = copyClassMembers(
      [{ id: "native:variable:Base:Health", kind: "variable", name: "Health", inheritedFrom: "Base" }],
      { graph: emptyTarget(), classId: "Child", parentGraphs: { Base: parent } },
    );
    expect(clip?.variables).toEqual([{ member: { ...HEALTH, id: "parent-health" }, sourceClassId: "Base" }]);
    expect(
      copyClassMembers(
        [{ id: "native:variable:Base:Health", kind: "variable", name: "Health", inheritedFrom: "Base" }],
        { graph: emptyTarget(), classId: "Child", parentGraphs: {} },
      ),
    ).toBeNull();
  });
});

describe("pasteClassMembers variables", () => {
  it("pastes duplicates with their category, default, type and flags, and a name free in the target", () => {
    const hero = heroGraph();
    const clip = copy(
      [row(hero, "variable", "Health"), row(hero, "variable", "Cue"), row(hero, "variable", "Scores")],
      hero,
    );
    const target = emptyTarget([{ id: "t-health", kind: "variable", name: "Health", typeId: "float" }]);
    const result = paste(clip, target);

    const added = result.graph.members!.slice(1);
    expect(added).toEqual([
      { ...HEALTH, id: "new-1", name: "Health_1" },
      { ...CUE, id: "new-2" },
      { ...SCORES, id: "new-3" },
    ]);
    expect(result.pasted).toEqual([
      { kind: "variable", id: "new-1", name: "Health_1" },
      { kind: "variable", id: "new-2", name: "Cue" },
      { kind: "variable", id: "new-3", name: "Scores" },
    ]);
    expect(result.skipped).toEqual([]);
    // The source is never moved.
    expect(hero.members).toEqual(heroGraph().members);
  });

  it("numbers repeated pastes into the same Class by the repo's duplicate naming", () => {
    const hero = heroGraph();
    const clip = copy([row(hero, "variable", "Health")], hero);
    const first = paste(clip, hero, { classId: "Hero" });
    const second = paste(clip, first.graph, { classId: "Hero", idFactory: sequence("again-") });
    expect(namesOf(second.graph, "variable")).toEqual(["Health", "Mana", "Cue", "Scores", "Temp", "Health_1", "Health_2"]);
    // Copying a copy continues the sequence instead of nesting suffixes.
    const copied = copy(
      [{ id: "new-1", kind: "variable", name: "Health_1" }],
      first.graph,
      "Hero",
    );
    expect(namesOf(paste(copied, second.graph, { classId: "Hero", idFactory: sequence("third-") }).graph, "variable").at(-1)).toBe("Health_3");
  });

  it("keeps a free name unchanged", () => {
    const clip = copy([row(heroGraph(), "variable", "Mana")]);
    expect(paste(clip, emptyTarget()).pasted).toEqual([{ kind: "variable", id: "new-1", name: "Mana" }]);
  });

  it("is not changed by editing the pasted copy, and a paste does not consume the clipboard", () => {
    const clip = copy([row(heroGraph(), "variable", "Health")]);
    const result = paste(clip, emptyTarget());
    result.graph.members![0]!.name = "Edited";
    expect(clip.variables[0]!.member.name).toBe("Health");
  });

  it("leaves variables out of a Class that cannot have them", () => {
    const hero = heroGraph();
    const clip = copy([row(hero, "variable", "Health"), row(hero, "function", "Helper")], hero);
    const result = paste(clip, emptyTarget(), { eventOptions: { parentClass: "FunctionLibrary" } });
    expect(result.skipped).toEqual([{ kind: "variable", name: "Health", reason: "kind" }]);
    expect(result.pasted.map((entry) => entry.name)).toEqual(["Helper"]);
    expect(skippedMembersNotice(result.skipped)).toBe("Health can't be added to this Class.");
  });

  describe("local variables", () => {
    const TEMP_ROW: ClassMemberCopyRow = { id: "var-temp", kind: "variable", name: "Temp", functionId: "fn-heal" };
    const target = () => emptyTarget([{ id: "t-fn", kind: "function", name: "Tick Rate", pins: FUNCTION_PINS }]);

    it("go into the target function, with a name free among the Class's variables", () => {
      const clip = copy([TEMP_ROW]);
      const graph = emptyTarget([
        { id: "t-fn", kind: "function", name: "Tick Rate", pins: FUNCTION_PINS },
        { id: "t-temp", kind: "variable", name: "Temp", typeId: "float" },
      ]);
      const result = paste(clip, graph, { targetFunctionId: "t-fn" });
      expect(result.graph.members!.at(-1)).toEqual({ ...TEMP, id: "new-1", name: "Temp_1", functionId: "t-fn" });
      expect(result.pasted).toEqual([{ kind: "variable", id: "new-1", name: "Temp_1", functionId: "t-fn" }]);
      expect(result.skipped).toEqual([]);
    });

    it("are left out, and named, when no function of the target is chosen", () => {
      const clip = copy([row(heroGraph(), "variable", "Health"), TEMP_ROW]);
      for (const targetFunctionId of [undefined, null, "missing", "t-health"]) {
        const graph = emptyTarget([{ id: "t-health", kind: "variable", name: "Mana", typeId: "int" }]);
        const result = paste(clip, graph, { targetFunctionId });
        expect(result.pasted.map((entry) => entry.name)).toEqual(["Health"]);
        expect(result.skipped).toEqual([{ kind: "variable", name: "Temp", reason: "function" }]);
        expect(skippedMembersNotice(result.skipped)).toBe("Temp needs a function. Select or open one first.");
      }
    });

    it("go into a Function Library function, which has no other variables", () => {
      const clip = copy([row(heroGraph(), "variable", "Health"), TEMP_ROW]);
      const result = paste(clip, target(), {
        targetFunctionId: "t-fn",
        eventOptions: { parentClass: "FunctionLibrary" },
      });
      expect(result.pasted.map((entry) => entry.name)).toEqual(["Temp"]);
      expect(result.skipped).toEqual([{ kind: "variable", name: "Health", reason: "kind" }]);
    });
  });

  describe("component variables", () => {
    const ARM: SerializedComponent = {
      id: "prefab-component-2",
      classId: "MeshComponent",
      name: "Arm",
      category: "Limbs",
      properties: { shape: "box", targetComponentId: "prefab-mesh" },
      parentId: "prefab-mesh",
    };
    const componentRow = (component: SerializedComponent): ClassMemberCopyRow => ({
      id: `component:${component.id}`,
      kind: "variable",
      name: component.name ?? "Mesh",
      componentId: component.id,
    });
    const source = (): SerializedGraph => ({ ...heroGraph(), components: [structuredClone(MESH), structuredClone(ARM)] });
    const targetWith = (components?: SerializedComponent[], members: GraphClassMember[] = []): SerializedGraph => ({
      ...emptyTarget(members),
      ...(components ? { components } : {}),
    });

    it("add a copy of the component to the Class, with its type and settings, and a name free in the Class", () => {
      const clip = copy([componentRow(MESH)], source());
      const target = targetWith([{ id: "prefab-mesh", classId: "MeshComponent", properties: {} }]);
      const result = paste(clip, target, { takenNames: { variable: ["Mesh"], function: [] } });

      expect(result.graph.components).toEqual([
        target.components![0],
        {
          id: "prefab-component-2",
          classId: "MeshComponent",
          name: "Mesh 2",
          properties: MESH.properties,
          parentId: null,
          transform: MESH.transform,
        },
      ]);
      expect(result.pasted).toEqual([
        { kind: "variable", id: "component:prefab-component-2", name: "Mesh 2", componentId: "prefab-component-2" },
      ]);
      // No variable row is stored: the component is the variable.
      expect(result.graph.members).toEqual([]);
      expect(source().components![0]).toEqual(MESH);
    });

    it("keep a free name as the component's default label, and number repeated pastes", () => {
      const clip = copy([componentRow(MESH)], source());
      const first = paste(clip, targetWith([]));
      expect(first.graph.components).toEqual([expect.not.objectContaining({ name: expect.anything() })]);
      expect(first.pasted[0]!.name).toBe("Mesh");
      const second = paste(clip, first.graph, { takenNames: { variable: ["Mesh", "Mesh 2"], function: [] } });
      expect(second.pasted[0]!.name).toBe("Mesh 3");
      expect(second.graph.components!.map((component) => component.id)).toEqual(["prefab-component-1", "prefab-component-2"]);
    });

    it("attach to the Class root, and to the copy of their parent when it was pasted too", () => {
      const both = paste(copy([componentRow(MESH), componentRow(ARM)], source()), targetWith([]));
      const [mesh, arm] = both.graph.components!;
      expect(mesh!.parentId).toBeNull();
      expect(arm).toMatchObject({ name: "Arm", category: "Limbs", parentId: mesh!.id });
      // A reference to a sibling follows the copy of that sibling.
      expect(arm!.properties).toEqual({ shape: "box", targetComponentId: mesh!.id });

      const alone = paste(copy([componentRow(ARM)], source()), targetWith([]));
      expect(alone.graph.components![0]).toMatchObject({ parentId: null, properties: { targetComponentId: "prefab-mesh" } });
    });

    it("leave the starter box in a Class that never authored components, and take no id a parent uses", () => {
      const clip = copy([componentRow(ARM)], source());
      const fresh = paste(clip, targetWith());
      expect(fresh.graph.components!.map((component) => component.id)).toEqual(["prefab-mesh", "prefab-component-2"]);
      expect(fresh.pasted[0]!.componentId).toBe("prefab-component-2");

      const parent: SerializedGraph = { nodes: [], edges: [], components: [{ id: "prefab-component-1", classId: "MeshComponent", properties: {} }] };
      const inheriting = paste(clip, targetWith(), { ancestors: [{ classId: "Base", graph: parent }] });
      expect(inheriting.graph.components!.map((component) => component.id)).toEqual(["prefab-component-2"]);
    });

    it("are left out of a Class that cannot have that component", () => {
      const anchor: SerializedComponent = { id: "prefab-anchor", classId: "2DAnchorComponent", properties: {}, parentId: null };
      const land: SerializedComponent = { id: "prefab-land", classId: "LandscapeComponent", properties: {}, parentId: null };
      const hero = { ...source(), components: [land, anchor] };
      const clip = copy([componentRow({ ...land, name: "Land" }), componentRow({ ...anchor, name: "Anchor" })], hero);
      const actor = paste(clip, targetWith([]));
      expect(actor.skipped).toEqual([{ kind: "variable", name: "Anchor", reason: "kind" }]);
      expect(actor.graph.components!.map((component) => component.classId)).toEqual(["LandscapeComponent"]);
      const layer = paste(clip, targetWith([]), { eventOptions: { parentClass: "SceneLayerActor" } });
      expect(layer.skipped).toEqual([{ kind: "variable", name: "Land", reason: "kind" }]);
      expect(layer.graph.components!.map((component) => component.classId)).toEqual(["2DAnchorComponent"]);
      const library = paste(clip, targetWith([]), { eventOptions: { parentClass: "FunctionLibrary" } });
      expect(library.pasted).toEqual([]);
      expect(library.skipped).toHaveLength(2);
    });

    it("rebind the component Get nodes of a pasted function to the copy", () => {
      const hero = source();
      const getMesh = node("get-mesh", "variables.get", {
        title: "Get Mesh",
        variableName: "Mesh",
        variableId: "component:prefab-mesh",
        componentId: "prefab-mesh",
        typeId: "object",
        typeClassId: "MeshComponent",
        scope: "member",
        classId: "Hero",
      });
      const other = { ...getMesh, id: "get-other", data: { ...getMesh.data, componentId: "other", variableId: "component:other" } };
      hero.functionGraphs!["fn-helper"] = { nodes: [getMesh, other], edges: [] };
      const clip = copy([componentRow(MESH), row(hero, "function", "Helper")], hero);
      const result = paste(clip, targetWith([]), { takenNames: { variable: ["Mesh"], function: [] } });
      const component = result.graph.components![0]!;
      const helper = result.pasted.find((entry) => entry.kind === "function")!;
      const [rebound, untouched] = result.graph.functionGraphs![helper.id]!.nodes;
      expect(rebound!.data).toMatchObject({
        componentId: component.id,
        variableId: `component:${component.id}`,
        variableName: "Mesh 2",
        title: "Get Mesh 2",
        classId: "Enemy",
      });
      expect(untouched!.data).toMatchObject({ componentId: "other", variableId: "component:other" });
    });
  });
});

describe("pasteClassMembers functions", () => {
  it("duplicates the function with its signature, category, local variables and wires, and drops its interface and override bindings", () => {
    const hero = heroGraph();
    const clip = copy([row(hero, "function", "Heal")], hero);
    const result = paste(clip, emptyTarget());

    const [fn, local] = result.graph.members!;
    expect(fn).toEqual({
      id: "new-1",
      kind: "function",
      name: "Heal",
      pins: FUNCTION_PINS,
      category: "Combat",
      overridable: true,
    });
    expect(local).toEqual({ ...TEMP, id: "new-2", functionId: "new-1" });
    const slice = result.graph.functionGraphs!["new-1"]!;
    expect(slice.nodes.map((entry) => entry.type)).toEqual(healBody().nodes.map((entry) => entry.type));
    // Fresh ids everywhere, with the Input / Output convention kept.
    expect(slice.nodes.slice(0, 2).map((entry) => entry.id)).toEqual(["new-1-input", "new-1-output"]);
    const sourceIds = new Set(healBody().nodes.map((entry) => entry.id));
    expect(slice.nodes.every((entry) => !sourceIds.has(entry.id))).toBe(true);
    expect(new Set(slice.nodes.map((entry) => entry.id)).size).toBe(slice.nodes.length);
    // Wires follow the nodes they joined.
    const byOldId = new Map(healBody().nodes.map((entry, index) => [entry.id, slice.nodes[index]!.id]));
    expect(slice.edges.map((edge) => [edge.source, edge.target, edge.sourceHandle, edge.targetHandle])).toEqual([
      [byOldId.get("fn-heal-input"), byOldId.get("set-mana"), "exec", "execIn"],
      [byOldId.get("get-health"), byOldId.get("set-mana"), "value", "value"],
      [byOldId.get("set-mana"), byOldId.get("fn-heal-output"), "execOut", "then"],
    ]);
    expect(new Set(slice.edges.map((edge) => edge.id)).size).toBe(3);
    // The original function graph is untouched.
    expect(hero.functionGraphs!["fn-heal"]).toEqual(healBody());
  });

  it("gives a function and its local variable free names in the same Class", () => {
    const hero = heroGraph();
    const clip = copy([row(hero, "function", "Heal")], hero);
    const result = paste(clip, hero, { classId: "Hero" });
    const fn = result.graph.members!.find((member) => member.kind === "function" && member.id === "new-1")!;
    expect(fn.name).toBe("Heal_1");
    const local = result.graph.members!.find((member) => member.functionId === "new-1")!;
    expect(local.name).toBe("Temp_1");
    const getTemp = result.graph.functionGraphs!["new-1"]!.nodes.find((entry) => entry.data.scope === "local")!;
    expect(getTemp.data).toMatchObject({
      variableId: local.id,
      variableName: "Temp_1",
      functionId: "new-1",
      title: "Get Temp_1",
    });
  });

  describe("references inside a pasted body", () => {
    function bodyOf(result: ReturnType<typeof paste>, functionId = "new-1") {
      const nodes = result.graph.functionGraphs![functionId]!.nodes;
      const at = (index: number) => nodes[index]!.data;
      return {
        getHealth: at(2),
        setMana: at(3),
        callHelper: at(5),
        callSelf: at(6),
        callEvent: at(7),
      };
    }

    it("resolve to the copies that came in the same paste, after renames", () => {
      const hero = heroGraph();
      const clip = copy(
        [
          row(hero, "variable", "Health"),
          row(hero, "function", "Heal"),
          row(hero, "function", "Helper"),
          { id: "evt-healed", kind: "event", name: "On Healed" },
        ],
        hero,
      );
      const result = paste(clip, hero, { classId: "Hero" });

      const heal = result.pasted.find((entry) => entry.name === "Heal_1")!;
      const body = bodyOf(result, heal.id);
      expect(body.getHealth).toMatchObject({
        variableId: result.pasted.find((entry) => entry.name === "Health_1")!.id,
        variableName: "Health_1",
        title: "Get Health_1",
        classId: "Hero",
      });
      expect(body.callHelper).toMatchObject({ functionName: "Helper_1", title: "Call Helper_1", classId: "Hero" });
      expect(body.callSelf).toMatchObject({ functionName: "Heal_1", title: "Call Heal_1" });
      expect(body.callEvent).toMatchObject({ name: "On Healed 1", title: "Call On Healed 1" });
      // Mana was not copied, and the same Class still has it with the same type.
      expect(body.setMana).toMatchObject({ variableId: "var-mana", variableName: "Mana", classId: "Hero" });
    });

    it("prefer the pasted copy over a target member of the same name and type", () => {
      const hero = heroGraph();
      const clip = copy([row(hero, "variable", "Health"), row(hero, "function", "Heal")], hero);
      const target = emptyTarget([{ id: "t-health", kind: "variable", name: "Health", typeId: "float" }]);
      const result = paste(clip, target);
      const heal = result.pasted.find((entry) => entry.kind === "function")!;
      expect(bodyOf(result, heal.id).getHealth).toMatchObject({
        variableId: result.pasted.find((entry) => entry.name === "Health_1")!.id,
        variableName: "Health_1",
        classId: "Enemy",
      });
    });

    it("otherwise resolve to the target's member of the same name and type", () => {
      const hero = heroGraph();
      const clip = copy([row(hero, "function", "Heal")], hero);
      const target = emptyTarget(
        [
          { id: "t-health", kind: "variable", name: "Health", typeId: "float" },
          { id: "t-helper", kind: "function", name: "Helper", pins: FUNCTION_PINS },
          { id: "t-healed", kind: "event", name: "On Healed", pins: EVENT_PINS },
        ],
        [node("t-healed", "flow.event.custom", { name: "On Healed", pins: EVENT_PINS })],
      );
      const heal = paste(clip, target, { idFactory: sequence("new-") });
      const body = bodyOf(heal);
      expect(body.getHealth).toMatchObject({ variableId: "t-health", variableName: "Health", classId: "Enemy" });
      expect(body.callHelper).toMatchObject({ functionName: "Helper", classId: "Enemy" });
      expect(body.callEvent).toMatchObject({ name: "On Healed", classId: "Enemy" });
    });

    it("resolve to a member the target inherits, under the parent that declares it", () => {
      const hero = heroGraph();
      const clip = copy([row(hero, "function", "Heal")], hero);
      const parent: SerializedGraph = {
        nodes: [],
        edges: [],
        members: [{ id: "base-health", kind: "variable", name: "Health", typeId: "float" }],
      };
      const result = paste(clip, emptyTarget(), { ancestors: [{ classId: "Base", graph: parent }] });
      expect(bodyOf(result).getHealth).toMatchObject({
        variableId: "base-health",
        variableName: "Health",
        classId: "Base",
      });
    });

    it("stay broken, untouched, when the target has no member of that name and type, and nothing is created", () => {
      const hero = heroGraph();
      const clip = copy([row(hero, "function", "Heal")], hero);
      const target = emptyTarget(
        [
          { id: "t-health", kind: "variable", name: "Health", typeId: "int" },
          { id: "t-mana", kind: "variable", name: "Mana", typeId: "int" },
          { id: "t-helper", kind: "function", name: "Helper", pins: [FUNCTION_PINS[0]!, FUNCTION_PINS[1]!] },
        ],
      );
      const result = paste(clip, target);
      const body = bodyOf(result);
      // Wrong type, wrong signature, absent event: the original ids and names stay, so validation flags them.
      expect(body.getHealth).toMatchObject({ variableId: "var-health", variableName: "Health", classId: "Hero" });
      expect(body.callHelper).toMatchObject({ functionName: "Helper", classId: "Hero" });
      expect(body.callEvent).toMatchObject({ name: "On Healed", classId: "Hero" });
      // Same name and type exists for Mana, so that one resolves.
      expect(body.setMana).toMatchObject({ variableId: "t-mana", classId: "Enemy" });
      expect(namesOf(result.graph, "variable")).toEqual(["Health", "Mana", "Temp"]);
      expect(namesOf(result.graph, "function")).toEqual(["Helper", "Heal"]);
      expect(namesOf(result.graph, "event")).toEqual([]);
    });

    it("leave references that wire in their target object alone", () => {
      const hero = heroGraph();
      hero.functionGraphs!["fn-heal"]!.nodes[2] = variableNode("get-health", "variables.get", HEALTH, {
        implicitSelf: false,
      });
      const clip = copy([row(hero, "function", "Heal")], hero);
      const target = emptyTarget([{ id: "t-health", kind: "variable", name: "Health", typeId: "float" }]);
      expect(bodyOf(paste(clip, target)).getHealth).toMatchObject({ variableId: "var-health", classId: "Hero" });
    });
  });
});

describe("pasteClassMembers events", () => {
  it("pastes a custom event as a duplicate with its signature and a free name, below the existing nodes", () => {
    const hero = heroGraph();
    const clip = copy([{ id: "evt-healed", kind: "event", name: "On Healed" }], hero);
    const target = emptyTarget(
      [{ id: "t-healed", kind: "event", name: "On Healed", pins: [] }],
      [node("t-healed", "flow.event.custom", { name: "On Healed", title: "Event On Healed", pins: [] }, 80, 80)],
    );
    const result = paste(clip, target);

    const added = result.graph.nodes.at(-1)!;
    expect(added).toMatchObject({
      id: "new-1",
      type: "flow.event.custom",
      data: { name: "On Healed 1", title: "Event On Healed 1", pins: EVENT_PINS },
    });
    expect(added.position.x).toBe(80);
    expect(added.position.y).toBeGreaterThan(80 + 120);
    expect(result.graph.members!.at(-1)).toEqual({ id: "new-1", kind: "event", name: "On Healed 1", pins: EVENT_PINS });
    // The next copy is free of both.
    const again = paste(clip, result.graph, { idFactory: sequence("more-") });
    expect(again.graph.nodes.at(-1)!.data.name).toBe("On Healed 2");
  });

  it("treats names that differ only in case, or compile to one identifier, as taken", () => {
    const clip = copy([{ id: "evt-healed", kind: "event", name: "On Healed" }]);
    const target = emptyTarget([], [node("t", "flow.event.custom", { name: "on healed" })]);
    expect(paste(clip, target).graph.nodes.at(-1)!.data.name).toBe("On Healed 1");
    const spaced = emptyTarget([], [node("t", "flow.event.custom", { name: "On_Healed" })]);
    expect(paste(clip, spaced).graph.nodes.at(-1)!.data.name).toBe("On Healed 1");
  });

  it("starts the event graph at the usual corner when it has no nodes", () => {
    const clip = copy([{ id: "evt-healed", kind: "event", name: "On Healed" }]);
    expect(paste(clip, emptyTarget()).graph.nodes[0]!.position).toEqual({ x: 80, y: 80 });
  });

  it("stacks several pasted events without overlapping each other or the graph", () => {
    const clip = copy([
      { id: "evt-healed", kind: "event", name: "On Healed" },
      { id: "evt-begin", kind: "event", name: "Event Begin Play" },
    ]);
    const target = emptyTarget([], [node("existing", "debug.log", {}, 400, 300)]);
    const [first, second] = paste(clip, target).graph.nodes.slice(1);
    expect(first!.position.x).toBe(400);
    expect(first!.position.y).toBeGreaterThan(300);
    expect(second!.position.x).toBe(400);
    expect(second!.position.y).toBeGreaterThan(first!.position.y + 100);
  });

  it("pastes a native event as that event when the target does not have it", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    const result = paste(clip, emptyTarget());
    expect(result.graph.nodes).toEqual([
      {
        id: "new-1",
        type: "flow.event.beginPlay",
        position: { x: 80, y: 80 },
        data: { title: "Event Begin Play", __nodeType: "flow.event.beginPlay" },
      },
    ]);
    expect(result.graph.members ?? []).toEqual([]);
    expect(result.pasted).toEqual([{ kind: "event", id: "new-1", name: "Event Begin Play" }]);
  });

  it("pastes a native event the target already has as a custom event named like a duplicate of it", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    const target = emptyTarget([], [node("t-begin", "flow.event.beginPlay", { title: "Event Begin Play" })]);
    const first = paste(clip, target);
    expect(first.graph.nodes.at(-1)).toMatchObject({
      type: "flow.event.custom",
      data: { name: "Begin Play 1", title: "Event Begin Play 1", pins: [] },
    });
    expect(first.graph.members).toEqual([{ id: "new-1", kind: "event", name: "Begin Play 1", pins: [] }]);
    expect(first.pasted).toEqual([{ kind: "event", id: "new-1", name: "Begin Play 1" }]);
    const second = paste(clip, first.graph, { idFactory: sequence("more-") });
    expect(second.graph.nodes.at(-1)!.data.name).toBe("Begin Play 2");
    // The authored native event is still the only one of its kind.
    expect(second.graph.nodes.filter((entry) => entry.type === "flow.event.beginPlay")).toHaveLength(1);
  });

  it("pastes a native event a parent Class authors as that event, wired to Call Parent like one added by hand", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    const parent: SerializedGraph = { nodes: [node("p-begin", "flow.event.beginPlay", {})], edges: [] };
    const result = paste(clip, emptyTarget(), {
      ancestors: [{ classId: "Base", graph: parent }],
      eventOptions: { parentClass: "Base", parentOf: (id) => (id === "Base" ? "Actor" : null) },
    });
    expect(result.graph.nodes.map((entry) => entry.type)).toEqual(["flow.event.beginPlay", "flow.event.callParent"]);
    expect(result.graph.nodes[1]!.data).toMatchObject({ eventType: "flow.event.beginPlay", parentClassId: "Base" });
    expect(result.graph.edges).toEqual([
      expect.objectContaining({
        source: "new-1",
        target: result.graph.nodes[1]!.id,
        sourceHandle: "execOut",
        targetHandle: "execIn",
      }),
    ]);
    expect(result.pasted).toEqual([{ kind: "event", id: "new-1", name: "Event Begin Play" }]);
  });

  it("adds no Call Parent when the Class has no parent to call", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    expect(paste(clip, emptyTarget()).graph.nodes.map((entry) => entry.type)).toEqual(["flow.event.beginPlay"]);
  });

  it("pastes two copies of one native event as the event and then a numbered custom event", () => {
    const hero = heroGraph();
    const clip = copy(
      [
        { id: "evt-begin", kind: "event", name: "Event Begin Play" },
        { id: "evt-begin", kind: "event", name: "Event Begin Play" },
      ],
      hero,
    );
    const result = paste(clip, emptyTarget());
    expect(result.graph.nodes.map((entry) => [entry.type, entry.data.name])).toEqual([
      ["flow.event.beginPlay", undefined],
      ["flow.event.custom", "Begin Play 1"],
    ]);
  });

  it("pastes a native event the target's Class cannot have as a numbered custom event, with nothing left out", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    const result = paste(clip, emptyTarget(), { eventOptions: { parentClass: "GameInstance" } });
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.graph.nodes[0]).toMatchObject({ type: "flow.event.custom", data: { name: "Begin Play 1" } });
    expect(result.skipped).toEqual([]);
  });

  it("gives a native event turned custom the native event's data outputs as parameters, in order and typed", () => {
    const hero = heroGraph();
    hero.nodes.push(
      node("evt-tick", "flow.event.tick", { title: "Event Tick" }),
      node("evt-hit", "flow.event.hit", { title: "Event On Hit" }),
    );
    const clip = copy(
      [
        { id: "evt-tick", kind: "event", name: "Event Tick" },
        { id: "evt-hit", kind: "event", name: "Event On Hit" },
      ],
      hero,
    );
    const target = emptyTarget([], [node("t-tick", "flow.event.tick", {}), node("t-hit", "flow.event.hit", {})]);
    const result = paste(clip, target);
    const [tick, hit] = result.graph.nodes.slice(2);
    expect(tick!.data).toMatchObject({
      name: "Tick 1",
      pins: [{ name: "deltaSeconds", typeId: "float", direction: "out" }],
    });
    expect(hit!.data.pins).toEqual([
      { name: "Hit Result", typeId: "struct", direction: "out", typeClassId: "engine:HitResult" },
      { name: "Other Actor", typeId: "actor", direction: "out", typeClassId: "Actor" },
      { name: "Location", typeId: "vec3", direction: "out" },
      { name: "Normal", typeId: "vec3", direction: "out" },
    ]);
    // The Class member row carries the same signature as the node.
    expect(result.graph.members!.find((member) => member.name === "On Hit 1")!.pins).toEqual(hit!.data.pins);
  });

  it("leaves a bound event out when the target already has it, and keeps one it can host", () => {
    const hero = heroGraph();
    hero.nodes.push(
      node("evt-override", "flow.event.custom", {
        name: "Parent Event",
        title: "Event Parent Event (Inherited)",
        eventQualifier: "Inherited",
        pins: [],
      }),
    );
    hero.edges.push({ id: "e", source: "evt-override", target: "call-parent", sourceHandle: "execOut", targetHandle: "execIn" });
    hero.nodes.push(node("call-parent", "flow.event.callParent", {}));
    const clip = copy([{ id: "evt-override", kind: "event", name: "Parent Event" }], hero);
    expect(clip.events[0]!.bound).toBe(true);

    const parent: SerializedGraph = {
      nodes: [node("p-evt", "flow.event.custom", { name: "Parent Event", pins: [] })],
      edges: [],
    };
    const hosted = paste(clip, emptyTarget(), { ancestors: [{ classId: "Base", graph: parent }] });
    expect(hosted.graph.nodes[0]).toMatchObject({ type: "flow.event.custom", data: { name: "Parent Event", eventQualifier: "Inherited" } });

    const present = emptyTarget([], [node("t", "flow.event.custom", { name: "Parent Event" })]);
    expect(paste(clip, present, { ancestors: [{ classId: "Base", graph: parent }] }).skipped).toEqual([
      { kind: "event", name: "Parent Event", reason: "present" },
    ]);
    expect(paste(clip, emptyTarget()).skipped).toEqual([
      { kind: "event", name: "Parent Event", reason: "unavailable" },
    ]);
  });

  it("leaves events out of a Class that has no event graph", () => {
    const clip = copy([{ id: "evt-healed", kind: "event", name: "On Healed" }]);
    const result = paste(clip, emptyTarget(), { eventOptions: { parentClass: "FunctionLibrary" } });
    expect(result.skipped).toEqual([{ kind: "event", name: "On Healed", reason: "kind" }]);
  });
});

describe("pasteClassMembers a whole selection", () => {
  it("pastes 4 variables, 2 functions and Begin Play from one Class into another in one graph", () => {
    const hero = heroGraph();
    const clip = copy(
      [
        row(hero, "variable", "Health"),
        row(hero, "variable", "Mana"),
        row(hero, "variable", "Cue"),
        row(hero, "variable", "Scores"),
        row(hero, "function", "Heal"),
        row(hero, "function", "Helper"),
        { id: "evt-begin", kind: "event", name: "Event Begin Play" },
      ],
      hero,
    );
    const target = emptyTarget([{ id: "t-mana", kind: "variable", name: "Mana", typeId: "int" }], [
      node("t-begin", "flow.event.beginPlay", { title: "Event Begin Play" }),
    ]);
    const result = paste(clip, target);

    expect(result.pasted.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "variable:Health",
      "variable:Mana_1",
      "variable:Cue",
      "variable:Scores",
      "function:Heal",
      "function:Helper",
      "event:Begin Play 1",
    ]);
    expect(result.graph.members!.find((member) => member.name === "Health")!.category).toBe("Stats|Core");
    expect(Object.keys(result.graph.functionGraphs!)).toEqual(
      result.pasted.filter((entry) => entry.kind === "function").map((entry) => entry.id),
    );
    // The Class's own members and nodes are untouched.
    expect(result.graph.members![0]).toEqual({ id: "t-mana", kind: "variable", name: "Mana", typeId: "int" });
    expect(result.graph.nodes[0]).toEqual(target.nodes[0]);
  });

  it("returns the graph itself when nothing could be pasted", () => {
    const clip = copy([{ id: "evt-begin", kind: "event", name: "Event Begin Play" }]);
    const target = emptyTarget();
    const result = paste(clip, target, { eventOptions: { parentClass: "FunctionLibrary" } });
    expect(result.graph).toBe(target);
    expect(result.pasted).toEqual([]);
  });
});

describe("skippedMembersNotice", () => {
  it("says nothing when nothing was left out", () => {
    expect(skippedMembersNotice([])).toBeNull();
  });

  it("names what was left out, one sentence per reason", () => {
    expect(
      skippedMembersNotice([
        { kind: "event", name: "Event Tick", reason: "present" },
        { kind: "event", name: "Event Begin Play", reason: "present" },
        { kind: "variable", name: "Health", reason: "kind" },
      ]),
    ).toBe("Health can't be added to this Class. Event Tick and Event Begin Play are already in this graph.");
  });
});

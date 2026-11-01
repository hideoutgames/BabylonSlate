import { describe, expect, it } from "vitest";
import { classHeaderMeta, type GraphClassMember, type SerializedGraph } from "@haptic/core";
import { delegateOf, FLOAT, STRING } from "@haptic/scripting";
import {
  addDispatcherNodes,
  adoptBoundEventSignatures,
  completeClassMemberDrop,
  patchClassMember,
  removeClassMember,
  resolveClassMemberDrop,
  type ClassMemberDropRow,
} from "./class-members";
import { copyClassMembers, pasteClassMembers } from "./class-member-clipboard";
import { classGraphFromHeaderPayload } from "./logic-graph-document";
import { createEventCandidates } from "./create-event-members";
import { delegateSignatureEntries } from "./delegate-signatures";
import { dispatcherPaletteNodes } from "../services/script-palette-members";
import { defaultNodeRegistry } from "../services/graph-hydration";

const ON_DAMAGED: GraphClassMember = {
  id: "on-damaged",
  kind: "dispatcher",
  name: "On Damaged",
  pins: [
    { name: "Damage", typeId: "float", direction: "in" },
    { name: "Source", typeId: "string", direction: "in" },
  ],
};

function ids(): () => string {
  let next = 0;
  return () => `n${++next}`;
}

function enemy(extra: Partial<SerializedGraph> = {}): SerializedGraph {
  return { nodes: [], edges: [], members: [ON_DAMAGED], ...extra };
}

/** A Bind node of the Enemy's own On Damaged, with a custom event wired into its Event. */
function boundGraph(eventPins: GraphClassMember["pins"]): SerializedGraph {
  return enemy({
    nodes: [
      {
        id: "listener",
        type: "flow.event.custom",
        position: { x: 0, y: 0 },
        data: { title: "Event Took Hit", name: "Took Hit", pins: eventPins },
      },
      {
        id: "bind",
        type: "flow.dispatcher.bind",
        position: { x: 300, y: 0 },
        data: { title: "Bind Event to On Damaged", name: "On Damaged", implicitSelf: true, pins: ON_DAMAGED.pins },
      },
    ],
    edges: [{ id: "e", source: "listener", sourceHandle: "OutputDelegate", target: "bind", targetHandle: "event" }],
  });
}

const nodeData = (graph: SerializedGraph, id: string) => graph.nodes.find((node) => node.id === id)?.data;

describe("Event Dispatcher members", () => {
  it("carry a rename and new inputs to their nodes, the events bound to them and copied Delegate types", () => {
    const graph: SerializedGraph = {
      ...boundGraph([
        { name: "Damage", typeId: "float", direction: "out" },
        { name: "Source", typeId: "string", direction: "out" },
      ]),
      members: [
        ON_DAMAGED,
        { id: "listener", kind: "event", name: "Took Hit", pins: [] },
        { id: "callback", kind: "variable", name: "Callback", typeId: "delegate", typeClassId: "Enemy::On Damaged", signature: [{ typeId: "float" }, { typeId: "string" }] },
      ],
    };
    const inputs = [{ name: "Amount", typeId: "int", direction: "in" as const }];

    const next = patchClassMember(graph, "on-damaged", { name: "On Hurt", pins: inputs }, "Enemy");

    expect(nodeData(next, "bind")).toMatchObject({ name: "On Hurt", title: "Bind Event to On Hurt", pins: inputs });
    expect(nodeData(next, "listener")?.pins).toEqual([{ name: "Amount", typeId: "int", direction: "out" }]);
    expect(next.members?.find((member) => member.id === "callback")).toMatchObject({
      typeClassId: "Enemy::On Hurt",
      signature: [{ typeId: "int" }],
    });
  });

  it("take their nodes with them when deleted", () => {
    const next = removeClassMember(boundGraph([]), "on-damaged", { classId: "Enemy" });
    expect(next.nodes.map((node) => node.id)).toEqual(["listener"]);
    expect(next.edges).toEqual([]);
  });

  it("give an empty custom event the dispatcher's inputs once it is wired to Bind, and leave one with inputs alone", () => {
    const adopted = adoptBoundEventSignatures(boundGraph([]), "Enemy");
    expect(nodeData(adopted, "listener")?.pins).toEqual([
      { name: "Damage", typeId: "float", direction: "out" },
      { name: "Source", typeId: "string", direction: "out" },
    ]);
    expect(adopted.members?.find((member) => member.id === "listener")).toMatchObject({ kind: "event", name: "Took Hit" });

    const own = [{ name: "Hit", typeId: "bool", direction: "out" as const }];
    expect(nodeData(adoptBoundEventSignatures(boundGraph(own), "Enemy"), "listener")?.pins).toEqual(own);
  });

  it("place Unreal's Assign as a Bind node wired from a matching custom event with a free name", () => {
    const taken = enemy({
      nodes: [{ id: "old", type: "flow.event.custom", position: { x: 0, y: 0 }, data: { name: "On Damaged", pins: [] } }],
    });

    const next = addDispatcherNodes(taken, ON_DAMAGED, "assign", { position: { x: 100, y: 50 }, idFactory: ids() });

    expect(next.nodes.slice(1).map((node) => [node.type, node.data.name, node.position])).toEqual([
      ["flow.event.custom", "On Damaged_1", { x: 60, y: 250 }],
      ["flow.dispatcher.bind", "On Damaged", { x: 100, y: 50 }],
    ]);
    expect(next.edges).toEqual([
      expect.objectContaining({ source: "n1", sourceHandle: "OutputDelegate", target: "n2", targetHandle: "event" }),
    ]);
  });

  it("ask which node to place when dropped, then place the chosen one for each", () => {
    const rows: ClassMemberDropRow[] = [{ id: "on-damaged", kind: "dispatcher", name: "On Damaged", pins: ON_DAMAGED.pins }];
    const canvas = { containsClientPoint: () => true, clientToFlow: () => ({ x: 10, y: 20 }) };
    const resolved = resolveClassMemberDrop({ graph: enemy(), memberIds: ["on-damaged"], members: rows, clientX: 0, clientY: 0, canvas });
    expect(resolved).toMatchObject({ kind: "choose-dispatcher", memberIds: ["on-damaged"], variables: false });

    const placed = completeClassMemberDrop({
      graph: enemy(), memberIds: ["on-damaged"], members: rows, position: { x: 10, y: 20 }, dispatcherAction: "unbindAll", classId: "Enemy",
    });
    expect(placed.graph.nodes.map((node) => [node.type, node.data.title])).toEqual([
      ["flow.dispatcher.unbindAll", "Unbind All Events from On Damaged"],
    ]);
  });
});

describe("Class headers", () => {
  it("keep Event Dispatchers and Delegate signatures for closed Classes", () => {
    const meta = classHeaderMeta({
      members: [
        ON_DAMAGED,
        { id: "callback", kind: "variable", name: "Callback", typeId: "delegate", typeClassId: "Enemy::On Damaged", signature: [{ typeId: "float" }, { typeId: "string" }] },
      ],
    });
    const graph = classGraphFromHeaderPayload(JSON.parse(JSON.stringify(meta)));

    expect(graph.members).toEqual([
      expect.objectContaining({ id: "callback", kind: "variable", typeId: "delegate", signature: [{ typeId: "float" }, { typeId: "string" }] }),
      { ...ON_DAMAGED },
    ]);
  });

  it("add no dispatchers key to a Class without dispatchers, so its header is unchanged", () => {
    expect(Object.keys(classHeaderMeta({ members: [] }))).not.toContain("dispatchers");
  });
});

describe("Event Dispatcher Add Node rows", () => {
  const palette = (options: Parameters<typeof dispatcherPaletteNodes>[1]) =>
    dispatcherPaletteNodes(defaultNodeRegistry, options);

  it("offer Call, Bind, Unbind, Unbind All and Assign on Self, and the same on a Target for other Classes", () => {
    const rows = palette({
      classId: "Bar",
      graph: { nodes: [], edges: [] },
      otherClassGraphs: { Enemy: enemy() },
      parentOf: () => "Actor",
    });

    expect(rows.filter((row) => !row.outOfContext).map((row) => [row.title, row.defaultData?.implicitSelf])).toEqual([
      ["Call On Damaged", false],
      ["Bind Event to On Damaged", false],
      ["Unbind Event from On Damaged", false],
      ["Unbind All Events from On Damaged", false],
      ["Assign On Damaged", false],
    ]);
    const assign = rows.find((row) => row.title === "Assign On Damaged");
    expect(assign?.bundle?.edges).toEqual([{ source: "event", sourceHandle: "OutputDelegate", target: "main", targetHandle: "event" }]);
    expect(assign?.bundle?.nodes[0]?.node.defaultData).toMatchObject({ name: "On Damaged", title: "Event On Damaged" });
    // Only from a dragged delegate pin: a matching custom event or Create Event.
    expect(rows.filter((row) => row.outOfContext).map((row) => row.title)).toEqual([
      "Add Custom Event for On Damaged",
      "Create Event for On Damaged",
    ]);
  });

  it("name the custom event a dragged delegate pin adds after its dispatcher, free among the Class's events", () => {
    const options = (graph: SerializedGraph) => ({ classId: "Enemy", graph });
    const addEvent = (graph: SerializedGraph) =>
      palette(options(graph)).find((row) => row.title === "Add Custom Event for On Damaged");

    // The row names the action; the node it adds is the event itself.
    expect(addEvent(enemy())).toMatchObject({ nodeTitle: "Event On Damaged", defaultData: { name: "On Damaged" } });
    const taken = enemy({
      nodes: [
        { id: "a", type: "flow.event.custom", position: { x: 0, y: 0 }, data: { name: "On Damaged", pins: [] } },
        { id: "b", type: "flow.event.custom", position: { x: 0, y: 0 }, data: { name: "On Damaged_1", pins: [] } },
      ],
    });
    expect(addEvent(taken)).toMatchObject({ nodeTitle: "Event On Damaged_2", defaultData: { name: "On Damaged_2" } });
  });

  it("leave out rows that add a custom event inside a function", () => {
    const titles = palette({ classId: "Enemy", graph: enemy(), activeFunctionId: "fn" }).map((row) => row.title);
    expect(titles).toEqual(["Call On Damaged", "Bind Event to On Damaged", "Unbind Event from On Damaged", "Unbind All Events from On Damaged"]);
  });
});

describe("Event Dispatcher copy and paste", () => {
  it("pastes a copy under a free name, and nothing into a Function Library", () => {
    const clip = copyClassMembers([{ id: "on-damaged", kind: "dispatcher", name: "On Damaged" }], { graph: enemy(), classId: "Enemy" })!;
    const pasted = pasteClassMembers({ graph: enemy(), clipboard: clip, classId: "Enemy", takenNames: { variable: [], function: [] }, idFactory: ids() });
    expect(pasted.graph.members?.map((member) => [member.kind, member.name, member.pins])).toEqual([
      ["dispatcher", "On Damaged", ON_DAMAGED.pins],
      ["dispatcher", "On Damaged_1", ON_DAMAGED.pins],
    ]);

    const library = pasteClassMembers({
      graph: { nodes: [], edges: [] }, clipboard: clip, classId: "Lib", takenNames: { variable: [], function: [] },
      eventOptions: { parentClass: "FunctionLibrary" },
    });
    expect(library.skipped).toEqual([{ kind: "dispatcher", name: "On Damaged", reason: "kind" }]);
  });
});

describe("Create Event and Delegate signatures", () => {
  const bar: SerializedGraph = {
    nodes: [{ id: "e", type: "flow.event.custom", position: { x: 0, y: 0 }, data: { name: "Took Hit", pins: [{ name: "Amount", typeId: "float", direction: "out" }, { name: "By", typeId: "string", direction: "out" }] } }],
    edges: [],
    members: [
      { id: "f1", kind: "function", name: "Heal", pins: [{ name: "Amount", typeId: "float", direction: "in" }, { name: "From", typeId: "string", direction: "in" }] },
      { id: "f2", kind: "function", name: "Score", pins: [{ name: "Amount", typeId: "float", direction: "in" }, { name: "Total", typeId: "int", direction: "out" }] },
      { id: "f3", kind: "function", name: "Ping", pins: [] },
    ],
  };

  it("lists the Object's events and functions that take the wired delegate's inputs, never ones that return values", () => {
    const parentOf = () => null;
    const all = createEventCandidates({ objectClassId: "Bar", ownClassId: "Bar", graphs: { Bar: bar }, parentOf });
    expect(all.map((entry) => [entry.kind, entry.name, entry.implicitSelf])).toEqual([
      ["event", "Took Hit", true], ["function", "Heal", true], ["function", "Ping", true],
    ]);
    const matching = createEventCandidates({
      objectClassId: "Bar", ownClassId: "Other", graphs: { Bar: bar }, parentOf, delegate: delegateOf([FLOAT, STRING]),
    });
    expect(matching.map((entry) => [entry.name, entry.implicitSelf])).toEqual([["Took Hit", false], ["Heal", false]]);
  });

  it("offers every Class's Event Dispatchers as Delegate signatures, the open Class first", () => {
    const entries = delegateSignatureEntries({
      Arena: { nodes: [], edges: [], members: [{ id: "d", kind: "dispatcher", name: "On Round", pins: [{ name: "Round", typeId: "object", typeClassId: "Actor", direction: "in" }] }] },
      Enemy: enemy(),
    }, "Enemy");
    expect(entries.map((entry) => [entry.id, entry.signature, entry.parameterNames])).toEqual([
      ["Enemy::On Damaged", [{ typeId: "float" }, { typeId: "string" }], ["Damage", "Source"]],
      ["Arena::On Round", [{ typeId: "object", typeClassId: "Actor" }], ["Round"]],
    ]);
  });
});

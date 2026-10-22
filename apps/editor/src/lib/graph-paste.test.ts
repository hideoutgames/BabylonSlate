import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import type { GraphPasteElements } from "@haptic/graph-ui";
import { customEventRenameError } from "./class-members";
import { prepareClassGraphPaste } from "./graph-paste";

type CanvasNode = GraphPasteElements["nodes"][number];

const canvasNode = (id: string, typeId: string, data: Record<string, unknown> = {}): CanvasNode => ({
  id,
  type: "pin",
  position: { x: 0, y: 0 },
  data: { __nodeType: typeId, ...data },
});
const customEvent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  canvasNode(id, "flow.event.custom", { name, title: `Event ${name}`, ...extra });
const wire = (source: string, target: string) => ({
  id: `e:${source}:${target}`,
  source,
  target,
  sourceHandle: "then",
  targetHandle: "exec",
});
const graphOf = (nodes: CanvasNode[]): GraphPasteElements => ({ nodes, edges: [] });

const names = (nodes: readonly CanvasNode[]) => nodes.map((node) => String(node.data.name));
const storedNode = (node: CanvasNode): SerializedGraph["nodes"][number] => ({
  id: node.id,
  type: String(node.data.__nodeType),
  position: node.position,
  data: node.data,
});

describe("prepareClassGraphPaste custom events", () => {
  it("renames a duplicated custom event to a free name, in the shape of an actor's duplicate", () => {
    const original = customEvent("open", "Open Door");
    const first = prepareClassGraphPaste(graphOf([customEvent("open-1", "Open Door")]), graphOf([original]), null, null);
    expect(first.notice).toBeUndefined();
    expect(first.nodes[0]!.data).toMatchObject({ name: "Open Door Copy", title: "Event Open Door Copy" });
    const second = prepareClassGraphPaste(
      graphOf([customEvent("open-2", "Open Door")]),
      graphOf([original, ...first.nodes]),
      null,
      null,
    );
    expect(names(second.nodes)).toEqual(["Open Door Copy 2"]);
    // Copying the copy numbers it instead of growing "Copy Copy".
    const third = prepareClassGraphPaste(
      graphOf([customEvent("open-3", "Open Door Copy")]),
      graphOf([original, ...first.nodes, ...second.nodes]),
      null,
      null,
    );
    expect(names(third.nodes)).toEqual(["Open Door Copy 3"]);
  });

  it("passes the rename rule and keeps the copy's own pins", () => {
    const pins = [{ name: "who", typeId: "string", direction: "out" }];
    const original = customEvent("open", "Open Door", { pins });
    const [copy] = prepareClassGraphPaste(
      graphOf([customEvent("open-1", "Open Door", { pins })]),
      graphOf([original]),
      null,
      null,
    ).nodes;
    const merged: SerializedGraph = { nodes: [original, copy!].map(storedNode), edges: [] };
    expect(customEventRenameError(merged, "open-1", String(copy!.data.name))).toBeNull();
    expect(copy!.data.pins).toEqual(pins);
  });

  it("avoids names taken in the Class's other graphs and by names that compile to the same identifier", () => {
    const stored: SerializedGraph = {
      nodes: [],
      edges: [],
      functionGraphs: {
        helper: { nodes: [storedNode(customEvent("h", "Open/Door Copy"))], edges: [] },
      },
      members: [{ id: "m", kind: "event", name: "Open Door Copy 2" }],
    };
    const result = prepareClassGraphPaste(
      graphOf([customEvent("open-1", "Open Door")]),
      graphOf([customEvent("open", "Open Door")]),
      stored,
      null,
    );
    // "Open/Door Copy" compiles to the same event as "Open Door Copy".
    expect(names(result.nodes)).toEqual(["Open Door Copy 3"]);
  });

  it("looks in the event graph when pasting into a function graph, not its stale stored slice", () => {
    const stored: SerializedGraph = {
      nodes: [storedNode(customEvent("e", "Open Door Copy"))],
      edges: [],
      functionGraphs: { fn: { nodes: [], edges: [] } },
    };
    const result = prepareClassGraphPaste(
      graphOf([customEvent("open-1", "Open Door")]),
      graphOf([customEvent("open", "Open Door")]),
      stored,
      "fn",
    );
    expect(names(result.nodes)).toEqual(["Open Door Copy 2"]);
  });

  it("keeps a name nothing else uses, and gives two copies of one name different names", () => {
    const kept = prepareClassGraphPaste(graphOf([customEvent("a", "Ping")]), graphOf([]), null, null);
    expect(names(kept.nodes)).toEqual(["Ping"]);
    const pair = prepareClassGraphPaste(
      graphOf([customEvent("a", "Ping"), customEvent("b", "Ping")]),
      graphOf([customEvent("ping", "Ping")]),
      null,
      null,
    );
    expect(names(pair.nodes)).toEqual(["Ping Copy", "Ping Copy 2"]);
  });

  it("leaves the wires and the other values of the copies alone", () => {
    const pasted = {
      nodes: [customEvent("a", "Ping", { custom: { nested: 1 } }), canvasNode("log", "debug.log", { message: "Hi" })],
      edges: [wire("a", "log")],
    };
    const result = prepareClassGraphPaste(pasted, graphOf([customEvent("ping", "Ping")]), null, null);
    expect(result.nodes[0]!.data).toMatchObject({ name: "Ping Copy", custom: { nested: 1 } });
    expect(result.nodes[1]).toEqual(pasted.nodes[1]);
  });
});

describe("prepareClassGraphPaste singleton events", () => {
  it("leaves out an event the graph already has, keeps the rest and says so", () => {
    const pasted = {
      nodes: [
        canvasNode("tick-1", "flow.event.tick", { title: "Event Tick" }),
        canvasNode("log-1", "debug.log", { message: "Hi" }),
      ],
      edges: [wire("tick-1", "log-1")],
    };
    const current = graphOf([canvasNode("tick", "flow.event.tick", { title: "Event Tick" })]);
    const result = prepareClassGraphPaste(pasted, current, null, null);
    expect(result.nodes.map((node) => node.id)).toEqual(["log-1"]);
    expect(result.notice).toBe("Event Tick is already in this graph.");
  });

  it("pastes an event the graph does not have yet, and only one of a kind", () => {
    const pasted = graphOf([
      canvasNode("tick-1", "flow.event.tick", { title: "Event Tick" }),
      canvasNode("tick-2", "flow.event.tick", { title: "Event Tick" }),
    ]);
    const result = prepareClassGraphPaste(pasted, graphOf([canvasNode("begin", "flow.event.beginPlay")]), null, null);
    expect(result.nodes.map((node) => node.id)).toEqual(["tick-1"]);
    expect(result.notice).toBe("Event Tick is already in this graph.");
    const alone = prepareClassGraphPaste(graphOf(pasted.nodes.slice(0, 1)), graphOf([]), null, null);
    expect(alone.nodes).toHaveLength(1);
    expect(alone.notice).toBeUndefined();
  });

  it("names every event it left out", () => {
    const current = graphOf([
      canvasNode("tick", "flow.event.tick"),
      canvasNode("begin", "flow.event.beginPlay"),
      canvasNode("end", "flow.event.end"),
    ]);
    const pasted = graphOf([
      canvasNode("tick-1", "flow.event.tick", { title: "Event Tick" }),
      canvasNode("begin-1", "flow.event.beginPlay", { title: "Event Begin Play" }),
    ]);
    const result = prepareClassGraphPaste(pasted, current, null, null);
    expect(result.nodes).toEqual([]);
    expect(result.notice).toBe("Event Tick and Event Begin Play are already in this graph.");
    const three = prepareClassGraphPaste(
      graphOf([...pasted.nodes, canvasNode("end-1", "flow.event.end", { title: "Event End" })]),
      current,
      null,
      null,
    );
    expect(three.notice).toBe("Event Tick, Event Begin Play and Event End are already in this graph.");
  });

  it("tells component events apart by component", () => {
    const current = graphOf([canvasNode("hit", "flow.event.hit", { componentId: "col-1" })]);
    const result = prepareClassGraphPaste(
      graphOf([
        canvasNode("hit-1", "flow.event.hit", { componentId: "col-1", title: "Event On Hit (Collider)" }),
        canvasNode("hit-2", "flow.event.hit", { componentId: "col-2", title: "Event On Hit (Other)" }),
      ]),
      current,
      null,
      null,
    );
    expect(result.nodes.map((node) => node.id)).toEqual(["hit-2"]);
    expect(result.notice).toBe("Event On Hit (Collider) is already in this graph.");
  });

  it("tells input events apart by their binding asset, and pastes one whose binding is wired", () => {
    const input = (id: string, asset: string) =>
      canvasNode(id, "input.actionEvent", {
        title: "Event Jump",
        "default:binding": { Input: { Name: asset, Asset: asset } },
      });
    const current = graphOf([input("jump", "input-jump")]);
    const result = prepareClassGraphPaste(
      graphOf([input("jump-1", "input-jump"), input("fire-1", "input-fire")]),
      current,
      null,
      null,
    );
    expect(result.nodes.map((node) => node.id)).toEqual(["fire-1"]);
    const wired = prepareClassGraphPaste(
      { nodes: [input("jump-2", "input-jump"), canvasNode("binding", "input.getBinding")], edges: [{ ...wire("binding", "jump-2"), targetHandle: "binding" }] },
      current,
      null,
      null,
    );
    expect(wired.nodes.map((node) => node.id)).toEqual(["jump-2", "binding"]);
  });

  it("treats a custom event that cannot be renamed as a singleton", () => {
    const override = (id: string) => customEvent(id, "Interact", { eventQualifier: "Inherited" });
    const result = prepareClassGraphPaste(graphOf([override("a")]), graphOf([override("b")]), null, null);
    expect(result.nodes).toEqual([]);
    expect(result.notice).toBe("Event Interact is already in this graph.");
    expect(prepareClassGraphPaste(graphOf([override("a")]), graphOf([]), null, null).nodes).toHaveLength(1);
  });

  it("does nothing for nodes that are not events", () => {
    const pasted = graphOf([canvasNode("log-1", "debug.log"), canvasNode("call", "flow.event.call", { name: "Ping" })]);
    const result = prepareClassGraphPaste(pasted, graphOf([canvasNode("log", "debug.log")]), null, null);
    expect(result).toEqual({ nodes: pasted.nodes });
  });
});

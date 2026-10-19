import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument } from "./graph-types";
import { treeNodeTypes } from "./tree-node";
import type { GraphRunEvent, GraphRunTrace } from "./run-trace";

let animated: Element[] = [];
let frames: Array<() => void> = [];

beforeEach(() => {
  animated = [];
  frames = [];
  Element.prototype.animate = function (this: Element) {
    animated.push(this);
    return { cancel() {}, play() {} } as unknown as Animation;
  };
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

const pins = [
  { id: "execIn", name: "exec", kind: "exec" as const, direction: "in" as const, type: { kind: "exec" } },
  { id: "execOut", name: "then", kind: "exec" as const, direction: "out" as const, type: { kind: "exec" } },
  { id: "message", name: "message", kind: "data" as const, direction: "in" as const, type: { kind: "string" } },
  { id: "value", name: "value", kind: "data" as const, direction: "out" as const, type: { kind: "string" } },
];

const document: GraphDocument = {
  nodes: [
    { id: "a", type: "debug.log", position: { x: 0, y: 0 }, data: { title: "Log", __pins: pins } },
    { id: "b", type: "debug.log", position: { x: 400, y: 0 }, data: { title: "Log", __pins: pins } },
  ],
  edges: [],
};

function openTrace() {
  const listeners = new Set<(run: GraphRunEvent) => void>();
  const trace: GraphRunTrace = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    value: () => undefined,
  };
  return { trace, listeners, emit: (run: GraphRunEvent) => act(() => {
    for (const listener of listeners) listener(run);
    const pending = frames;
    frames = [];
    for (const frame of pending) frame();
  }) };
}

it("marks each pin's side of its row so a tip can find the pin", () => {
  const { container } = render(<GraphEditor initialGraph={document} runTrace={openTrace().trace} />);
  const sides = [...container.querySelectorAll('[data-id="a"] [data-pin-side]')]
    .map((side) => `${side.getAttribute("data-pin-side")}:${side.getAttribute("data-pin-id")}`);
  expect(sides.sort()).toEqual(["in:execIn", "in:message", "out:execOut", "out:value"]);
});

it("flashes the node that ran without rendering any node again", () => {
  const renderNodeBody = vi.fn(() => null);
  const run = openTrace();
  const { container } = render(<GraphEditor initialGraph={document} renderNodeBody={renderNodeBody} runTrace={run.trace} />);
  const rendered = renderNodeBody.mock.calls.length;
  expect(rendered).toBeGreaterThan(0);

  for (let tick = 0; tick < 5; tick++) run.emit({ nodes: ["b"], edges: [] });

  expect(animated).toContain(container.querySelector('[data-id="b"] [data-node-role]'));
  expect(animated).not.toContain(container.querySelector('[data-id="a"] [data-node-role]'));
  expect(renderNodeBody).toHaveBeenCalledTimes(rendered);
});

it("stops listening to runs when the canvas unmounts", () => {
  const run = openTrace();
  const view = render(<GraphEditor initialGraph={document} runTrace={run.trace} />);
  expect(run.listeners.size).toBeGreaterThan(0);
  view.unmount();
  expect(run.listeners.size).toBe(0);
});

it("updates only the Behaviour Tree node whose status changed", () => {
  const statuses: Record<string, string> = { a: "running" };
  const watchers = new Map<string, Set<() => void>>();
  const reads: string[] = [];
  const trace: GraphRunTrace = {
    subscribe: () => () => {},
    value: () => undefined,
    status: (nodeId) => { reads.push(nodeId); return statuses[nodeId]; },
    subscribeStatus: (nodeId, listener) => {
      const set = watchers.get(nodeId) ?? new Set();
      watchers.set(nodeId, set.add(listener));
      return () => { set.delete(listener); };
    },
  };
  const tree: GraphDocument = {
    nodes: ["a", "b"].map((id, index) => ({
      id, type: "bt.node", position: { x: index * 300, y: 0 },
      data: { title: id, kind: "task", classId: "bt.task.wait", sortIndex: index, __pins: [{ id: "parent", name: "parent", kind: "exec", direction: "in", type: { kind: "exec" } }] },
    })),
    edges: [],
  };
  const { getByTestId } = render(<GraphEditor initialGraph={tree} nodeTypes={treeNodeTypes} runTrace={trace} />);
  const state = (id: string) => getByTestId(`bt-node-${id}`).getAttribute("data-bt-state");
  expect([state("a"), state("b")]).toEqual(["running", "idle"]);

  const before = reads.filter((id) => id === "b").length;
  act(() => {
    statuses.a = "failure";
    for (const listener of watchers.get("a") ?? []) listener();
  });
  expect([state("a"), state("b")]).toEqual(["failure", "idle"]);
  expect(reads.filter((id) => id === "b")).toHaveLength(before);
});

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunOverlay } from "./graph-run-overlay";
import type { GraphRunEvent, GraphRunTrace, RunGraph } from "./run-trace";

let frames: Array<() => void> = [];
beforeEach(() => {
  frames = [];
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const runFrame = () => act(() => { const pending = frames; frames = []; for (const frame of pending) frame(); });

type Pin = { id: string; kind: "exec" | "data"; direction: "in" | "out" };
const node = (id: string, pins: Pin[]) => ({
  id,
  data: { __pins: pins.map((pin) => ({ ...pin, name: pin.id, type: { kind: "float" } })) },
});

const graph: RunGraph = {
  nodes: [
    node("make", [{ id: "then", kind: "exec", direction: "out" }, { id: "value", kind: "data", direction: "out" }]),
    node("log", [
      { id: "exec", kind: "exec", direction: "in" },
      { id: "message", kind: "data", direction: "in" },
      { id: "extra", kind: "data", direction: "in" },
    ]),
  ],
  edges: [
    { id: "e", source: "make", sourceHandle: "then", target: "log", targetHandle: "exec" },
    { id: "d", source: "make", sourceHandle: "value", target: "log", targetHandle: "message" },
  ],
};

/** The pin rows as the graph renders them: a side per pin holding its handle and label. */
function mountCanvas() {
  const root = document.createElement("div");
  const side = (direction: "in" | "out", pinId: string) => `
    <div data-pin-side="${direction}" data-pin-id="${pinId}">
      <span data-pin-label="${pinId}">${pinId}</span>
      <div class="react-flow__handle" data-nodeid="" data-handleid="${pinId}"></div>
    </div>`;
  root.innerHTML = `
    <div class="react-flow__node" data-id="make">${side("out", "then")}${side("out", "value")}</div>
    <div class="react-flow__node" data-id="log">${side("in", "exec")}${side("in", "message")}${side("in", "extra")}</div>
    <div class="react-flow__node" data-id="wait"><button data-run-status-tip><span>Wait</span></button></div>`;
  document.body.append(root);
  return root;
}

function fakeTrace(values: Record<string, string>, statuses?: Record<string, string>) {
  const listeners = new Set<(run: GraphRunEvent) => void>();
  const watchers = new Set<() => void>();
  const trace: GraphRunTrace = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    value: (nodeId, pinId, direction) => values[`${nodeId}.${pinId}.${direction}`],
    ...(statuses ? {
      status: (nodeId: string) => statuses[nodeId],
      subscribeStatus: (_nodeId: string, listener: () => void) => { watchers.add(listener); return () => { watchers.delete(listener); }; },
    } : {}),
  };
  return {
    trace, values, statuses, watchers,
    emit: () => act(() => { for (const listener of listeners) listener({ nodes: [], edges: [] }); }),
    changeStatus: (nodeId: string, status: string) => act(() => { statuses![nodeId] = status; for (const watcher of watchers) watcher(); }),
  };
}

function pointer(target: Element, type: string, init: { pointerType?: string; relatedTarget?: Element | null } = {}) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: init.relatedTarget ?? null });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  act(() => { target.dispatchEvent(event); });
}

function setup(values: Record<string, string> = {}, statuses?: Record<string, string>) {
  const root = mountCanvas();
  const probe = fakeTrace(values, statuses);
  render(<GraphRunOverlay root={{ current: root }} trace={probe.trace} graph={() => graph} />);
  const side = (nodeId: string, pinId: string) => root.querySelector(`[data-id="${nodeId}"] [data-pin-id="${pinId}"]`)!;
  const header = (nodeId: string) => root.querySelector(`[data-id="${nodeId}"] [data-run-status-tip]`)!;
  return { root, side, header, ...probe };
}

const tip = () => screen.queryByTestId("graph-pin-value-tip");
const statusTip = () => screen.queryByTestId("graph-node-status-tip");

describe("pin value tip on desktop", () => {
  it("shows No value yet over a pin nothing has run through, then its last value as runs arrive", () => {
    const { side, values, emit } = setup();
    pointer(side("make", "value"), "pointerover");
    expect(tip()?.textContent).toBe("No value yet");
    values["make.value.out"] = "3";
    emit();
    expect(tip()?.textContent).toBe("No value yet");
    runFrame();
    expect(tip()?.textContent).toBe("3");
  });

  it("shows what a node that ran read through a wired input, and a source's value for it", () => {
    const { side } = setup({ "log.message.in": "hello" });
    pointer(side("log", "message"), "pointerover");
    expect(tip()?.textContent).toBe("hello");
  });

  it("goes away when the pointer leaves the pin, but not when it moves within it", () => {
    const { side } = setup({ "make.value.out": "3" });
    const value = side("make", "value");
    pointer(value, "pointerover");
    pointer(value.querySelector("span")!, "pointerout", { relatedTarget: value.querySelector(".react-flow__handle") });
    expect(tip()?.textContent).toBe("3");
    pointer(value, "pointerout", { relatedTarget: document.body });
    expect(tip()).toBeNull();
  });

  it("offers nothing over exec pins or an input nothing is wired into", () => {
    const { side } = setup({ "log.extra.in": "x" });
    for (const [nodeId, pinId] of [["make", "then"], ["log", "exec"], ["log", "extra"]] as const) {
      pointer(side(nodeId, pinId), "pointerover");
      expect(tip(), `${nodeId}.${pinId}`).toBeNull();
    }
  });

  it("shows an empty text value as an empty string literal", () => {
    const { side } = setup({ "make.value.out": "" });
    pointer(side("make", "value"), "pointerover");
    expect(tip()?.textContent).toBe('""');
  });

  it("ignores the hover a touch gesture synthesizes", () => {
    const { side } = setup({ "make.value.out": "3" });
    pointer(side("make", "value"), "pointerover", { pointerType: "touch" });
    expect(tip()).toBeNull();
  });
});

describe("pin value tip on touch", () => {
  const tap = (target: Element) => {
    pointer(target, "pointerdown", { pointerType: "touch" });
    act(() => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  it("opens on a tap of the pin's label and toggles with the next tap on it", () => {
    const { side } = setup({ "make.value.out": "3" });
    const label = side("make", "value").querySelector("[data-pin-label]")!;
    tap(label);
    expect(tip()?.textContent).toBe("3");
    tap(label);
    expect(tip()).toBeNull();
  });

  it("leaves a tap on the handle to tap-to-connect", () => {
    const { side } = setup({ "make.value.out": "3" });
    tap(side("make", "value").querySelector(".react-flow__handle")!);
    expect(tip()).toBeNull();
  });

  it("closes on a press anywhere else", () => {
    const { side, root } = setup({ "make.value.out": "3" });
    tap(side("make", "value").querySelector("[data-pin-label]")!);
    pointer(root, "pointerdown", { pointerType: "touch" });
    expect(tip()).toBeNull();
  });

  it("does not open on a mouse click of a label, which hover already covers", () => {
    const { side } = setup({ "make.value.out": "3" });
    const label = side("make", "value").querySelector("[data-pin-label]")!;
    pointer(label, "pointerdown", { pointerType: "mouse" });
    act(() => { label.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(tip()).toBeNull();
  });
});

describe("node status tip", () => {
  it("shows a node's status in Title Case over its header, and says so when it has none", () => {
    const { header } = setup({}, { wait: "running" });
    pointer(header("wait"), "pointerover");
    expect(statusTip()?.textContent).toBe("Running");
    expect(tip()).toBeNull();
    pointer(header("wait"), "pointerout", { relatedTarget: document.body });
    expect(statusTip()).toBeNull();
  });

  it("says there is no status yet before the node has one", () => {
    const { header } = setup({}, {});
    pointer(header("wait"), "pointerover");
    expect(statusTip()?.textContent).toBe("No status yet");
  });

  it("follows the node's status while the tip is open, and stops watching it when it closes", () => {
    const { header, changeStatus, watchers } = setup({}, { wait: "running" });
    pointer(header("wait"), "pointerover");
    expect(watchers.size).toBe(1);
    changeStatus("wait", "failure");
    expect(statusTip()?.textContent).toBe("Running");
    runFrame();
    expect(statusTip()?.textContent).toBe("Failure");
    pointer(header("wait"), "pointerout", { relatedTarget: document.body });
    expect(watchers.size).toBe(0);
  });

  it("opens on a touch tap of the header and closes on the next tap or a press elsewhere", () => {
    const { header, root } = setup({}, { wait: "success" });
    const tapHeader = () => {
      pointer(header("wait"), "pointerdown", { pointerType: "touch" });
      act(() => { header("wait").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    };
    tapHeader();
    expect(statusTip()?.textContent).toBe("Success");
    tapHeader();
    expect(statusTip()).toBeNull();
    tapHeader();
    pointer(root, "pointerdown", { pointerType: "touch" });
    expect(statusTip()).toBeNull();
  });

  it("offers nothing when the graph reports no node status", () => {
    const { header } = setup();
    pointer(header("wait"), "pointerover");
    expect(statusTip()).toBeNull();
  });
});

describe("GraphRunOverlay lifetime", () => {
  it("stops listening to the trace once unmounted", () => {
    const root = mountCanvas();
    const probe = fakeTrace({});
    const subscribe = vi.spyOn(probe.trace, "subscribe");
    const view = render(<GraphRunOverlay root={{ current: root }} trace={probe.trace} graph={() => graph} />);
    expect(subscribe).toHaveBeenCalled();
    const unsubscribed = subscribe.mock.results.length;
    view.unmount();
    probe.emit();
    expect(unsubscribed).toBeGreaterThan(0);
    expect(tip()).toBeNull();
  });
});

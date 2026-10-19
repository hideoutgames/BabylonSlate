import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_FLASH_MS, createRunFlasher } from "./run-flash";
import type { RunGraph } from "./run-trace";

type FakeAnimation = { cancel: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> };
type AnimateCall = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: FakeAnimation };

let calls: AnimateCall[] = [];
let frames: Array<() => void> = [];
let reducedMotion = false;

beforeEach(() => {
  calls = [];
  frames = [];
  reducedMotion = false;
  Element.prototype.animate = function (this: Element, keyframes, options) {
    const animation = { cancel: vi.fn(), play: vi.fn() };
    calls.push({ element: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, animation });
    return animation as unknown as Animation;
  };
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes("reduce") })) as typeof window.matchMedia;
});
afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

const runFrame = () => { const pending = frames; frames = []; for (const frame of pending) frame(); };

type Pin = { id: string; kind: "exec" | "data"; direction: "in" | "out" };
const pinData = (pins: Pin[], pure = false) => ({
  __pins: pins.map((pin) => ({ ...pin, name: pin.id, type: { kind: "float" } })),
  ...(pure ? { __pure: true } : {}),
});

/** make -exec-> log, with Log.message read from the pure Add. Every handle and wire is in the DOM. */
function canvas() {
  const graph: RunGraph = {
    nodes: [
      { id: "make", data: pinData([{ id: "then", kind: "exec", direction: "out" }]) },
      { id: "add", data: pinData([{ id: "sum", kind: "data", direction: "out" }], true) },
      { id: "log", data: pinData([{ id: "exec", kind: "exec", direction: "in" }, { id: "message", kind: "data", direction: "in" }]) },
    ],
    edges: [
      { id: "e-exec", source: "make", sourceHandle: "then", target: "log", targetHandle: "exec" },
      { id: "d-msg", source: "add", sourceHandle: "sum", target: "log", targetHandle: "message" },
    ],
  };
  const root = document.createElement("div");
  for (const node of graph.nodes) {
    const pins = (node.data as { __pins: Pin[] }).__pins;
    root.insertAdjacentHTML("beforeend", `<div class="react-flow__node" data-id="${node.id}">
      <div data-node-role="event">${pins.map((pin) =>
        `<div class="react-flow__handle" data-nodeid="${node.id}" data-handleid="${pin.id}"><svg class="graph-pin-visual"></svg></div>`).join("")}</div>
    </div>`);
  }
  for (const edge of graph.edges) {
    root.insertAdjacentHTML("beforeend", `<svg><g class="react-flow__edge" data-id="${edge.id}"><path class="react-flow__edge-interaction"></path><path class="react-flow__edge-path"></path></g></svg>`);
  }
  document.body.append(root);
  return { graph, root, flasher: createRunFlasher(root, () => graph) };
}

const animated = (root: Element, selector: string) => calls.filter((call) => call.element === root.querySelector(selector));

describe("createRunFlasher", () => {
  it("fades the outline of a node that ran, over 0.25 s, from the selection colour", () => {
    const { root, flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: [] });
    expect(calls).toHaveLength(0);
    runFrame();
    const [outline] = animated(root, '[data-id="log"] [data-node-role]');
    expect(outline!.options).toMatchObject({ duration: 250 });
    expect(RUN_FLASH_MS).toBe(250);
    expect(outline!.keyframes[0]).toMatchObject({ outlineColor: "var(--selection)" });
    expect(outline!.keyframes.at(-1)).toMatchObject({ outlineColor: "transparent" });
    // Only the node that ran: not make, and the pure Add never gets an outline.
    expect(animated(root, '[data-id="make"] [data-node-role]')).toEqual([]);
    expect(animated(root, '[data-id="add"] [data-node-role]')).toEqual([]);
  });

  it("flashes the wires and pins of what flowed: exec wire taken, data wires read through pure nodes", () => {
    const { root, flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: ["e-exec"] });
    runFrame();
    expect(animated(root, '[data-id="e-exec"] .react-flow__edge-path')).toHaveLength(1);
    // Log read Add.sum, so the data wire lights up although it was not reported.
    expect(animated(root, '[data-id="d-msg"] .react-flow__edge-path')).toHaveLength(1);
    // The interaction hit area never flashes.
    expect(animated(root, ".react-flow__edge-interaction")).toEqual([]);
    for (const [nodeId, pinId] of [["make", "then"], ["log", "exec"], ["add", "sum"], ["log", "message"]]) {
      expect(animated(root, `[data-nodeid="${nodeId}"][data-handleid="${pinId}"] .graph-pin-visual`), `${nodeId}.${pinId}`).toHaveLength(1);
    }
  });

  it("starts a wire's fade from the flash colour and lets it settle on the wire's own paint", () => {
    const { root, flasher } = canvas();
    flasher.flash({ nodes: [], edges: ["e-exec"] });
    runFrame();
    const [wire] = animated(root, '[data-id="e-exec"] .react-flow__edge-path');
    // A lone keyframe without an offset is the END of an animation, which would fade the wire towards the flash colour.
    expect(wire!.keyframes).toHaveLength(1);
    expect(wire!.keyframes[0]).toMatchObject({ offset: 0, stroke: expect.stringContaining("var(--selection)") as unknown as string });
  });

  it("restarts the same element's fade from full strength instead of stacking animations", () => {
    const { root, flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: [] });
    runFrame();
    const [first] = animated(root, '[data-id="log"] [data-node-role]');
    flasher.flash({ nodes: ["log"], edges: [] });
    runFrame();
    expect(animated(root, '[data-id="log"] [data-node-role]')).toHaveLength(1);
    expect(first!.animation.cancel).toHaveBeenCalledTimes(1);
    expect(first!.animation.play).toHaveBeenCalledTimes(1);
  });

  it("coalesces the runs of one frame into one animation per element", () => {
    const { root, flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: ["e-exec"] });
    flasher.flash({ nodes: ["log", "make"], edges: ["e-exec"] });
    runFrame();
    expect(animated(root, '[data-id="log"] [data-node-role]')).toHaveLength(1);
    expect(animated(root, '[data-id="e-exec"] .react-flow__edge-path')).toHaveLength(1);
    expect(frames).toHaveLength(0);
  });

  it("skips what the canvas does not render, such as nodes scrolled out of a virtualized view", () => {
    const { root, flasher } = canvas();
    root.querySelector('[data-id="log"]')!.remove();
    flasher.flash({ nodes: ["log", "unknown"], edges: ["gone"] });
    expect(() => runFrame()).not.toThrow();
    expect(animated(root, '[data-id="log"] [data-node-role]')).toEqual([]);
  });

  it("under reduced motion holds the highlight for the same time instead of fading it", () => {
    reducedMotion = true;
    const { root, flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: ["e-exec"] });
    runFrame();
    for (const selector of ['[data-id="log"] [data-node-role]', '[data-id="e-exec"] .react-flow__edge-path']) {
      const [call] = animated(root, selector);
      expect(call!.options).toMatchObject({ duration: 250, easing: "steps(1, end)" });
      expect(new Set(call!.keyframes.map((frame) => JSON.stringify(frame))).size).toBe(1);
    }
  });

  it("does nothing after it is disposed", () => {
    const { flasher } = canvas();
    flasher.flash({ nodes: ["log"], edges: [] });
    flasher.dispose();
    runFrame();
    flasher.flash({ nodes: ["log"], edges: [] });
    runFrame();
    expect(calls).toEqual([]);
  });
});

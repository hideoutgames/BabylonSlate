import { dataWiresRead, wireEnds, type GraphRunEvent, type RunGraph } from "./run-trace";

/** How long an executed node, pin or wire keeps its highlight. */
export const RUN_FLASH_MS = 250;

const FLASH_COLOR = "var(--selection)";
const NODE_SHELL = "[data-node-role]";
const WIRE_PATH = ".react-flow__edge-path";
const PIN_GLYPH = ".graph-pin-visual";

type Frames = { keyframes: Keyframe[]; reduced: Keyframe[] };

const NODE_FRAMES: Frames = {
  keyframes: [
    { outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "0px", outlineColor: FLASH_COLOR },
    { outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "0px", outlineColor: "transparent" },
  ],
  reduced: [
    { outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "0px", outlineColor: FLASH_COLOR },
    { outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "0px", outlineColor: FLASH_COLOR },
  ],
};
// The wire fades from the flash colour back to whatever its own style paints, so its one keyframe is
// the start (`offset: 0`); the end is implicit. The start is a `color-mix()` rather than a bare
// `var(--selection)`: that is a legacy `rgb()` colour, which Chromium interpolates wrongly against
// the `oklch()` pin colours the wires are painted in. Wires whose stylesheet stroke is !important
// (tree and state wires) ignore `stroke` and fade `--run-flash` instead.
const WIRE_FLASH_START = `color-mix(in oklab, ${FLASH_COLOR} 100%, transparent)`;
const WIRE_FRAMES: Frames = {
  keyframes: [{ offset: 0, stroke: WIRE_FLASH_START, "--run-flash": "100%" }],
  reduced: [{ stroke: FLASH_COLOR, "--run-flash": "100%" }, { stroke: FLASH_COLOR, "--run-flash": "100%" }],
};
const PIN_FRAMES: Frames = {
  keyframes: [
    { filter: `drop-shadow(0 0 4px ${FLASH_COLOR})` },
    { filter: "drop-shadow(0 0 4px transparent)" },
  ],
  reduced: [
    { filter: `drop-shadow(0 0 4px ${FLASH_COLOR})` },
    { filter: `drop-shadow(0 0 4px ${FLASH_COLOR})` },
  ],
};

export interface RunFlasher {
  /** Highlights what ran. Calls within one animation frame coalesce. */
  flash(run: GraphRunEvent): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function attributeValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Draws what ran into the canvas DOM. Nothing here goes through React: a run is found by
 * node, wire and pin id and a Web Animation on that element fades its highlight in
 * `RUN_FLASH_MS`. Each new run of the same element restarts the fade from full strength.
 * Elements the canvas does not render (virtualized away) are skipped.
 *
 * Under `prefers-reduced-motion` the highlight does not fade: it holds at full strength for
 * the same time and clears.
 */
export function createRunFlasher(root: HTMLElement, graph: () => RunGraph): RunFlasher {
  const animations = new WeakMap<Element, { animation: Animation; reduced: boolean }>();
  const found = new Map<string, Element>();
  let pending: { nodes: Set<string>; edges: Set<string> } | null = null;
  let frame: number | null = null;
  let disposed = false;

  const find = (key: string, selector: string, within: ParentNode = root): Element | null => {
    const cached = found.get(key);
    if (cached?.isConnected) return cached;
    const element = within.querySelector(selector);
    if (element) found.set(key, element);
    else found.delete(key);
    return element;
  };
  const nodeElement = (id: string) => find(`n\0${id}`, `.react-flow__node[data-id="${attributeValue(id)}"]`);
  const edgeElement = (id: string) => find(`e\0${id}`, `.react-flow__edge[data-id="${attributeValue(id)}"]`);

  const restart = (element: Element, frames: Frames, reduced: boolean) => {
    const running = animations.get(element);
    if (running?.reduced === reduced) {
      // The same element ran before: start its fade over from full strength.
      running.animation.cancel();
      running.animation.play();
      return;
    }
    running?.animation.cancel();
    const animation = element.animate(reduced ? frames.reduced : frames.keyframes, {
      duration: RUN_FLASH_MS,
      easing: reduced ? "steps(1, end)" : "linear",
    });
    animations.set(element, { animation, reduced });
  };

  const flashNode = (id: string, reduced: boolean) => {
    const element = nodeElement(id);
    if (!element) return;
    restart(element.querySelector(NODE_SHELL) ?? element, NODE_FRAMES, reduced);
  };
  const flashWire = (id: string, reduced: boolean) => {
    const path = edgeElement(id)?.querySelector(WIRE_PATH);
    if (path) restart(path, WIRE_FRAMES, reduced);
  };
  const flashPin = (nodeId: string, pinId: string, reduced: boolean) => {
    const node = nodeElement(nodeId);
    const handle = node?.querySelector(`[data-nodeid="${attributeValue(nodeId)}"][data-handleid="${attributeValue(pinId)}"]`);
    const glyph = handle?.querySelector(PIN_GLYPH);
    if (glyph) restart(glyph, PIN_FRAMES, reduced);
  };

  const run = () => {
    frame = null;
    const batch = pending;
    pending = null;
    if (!batch || disposed) return;
    const reduced = prefersReducedMotion();
    const current = graph();
    const edgesById = new Map(current.edges.map((edge) => [edge.id, edge]));
    const wires = new Map<string, RunGraph["edges"][number]>();
    for (const id of batch.edges) {
      const edge = edgesById.get(id);
      if (edge) wires.set(id, edge);
    }
    for (const id of batch.nodes) {
      flashNode(id, reduced);
      // A node that ran read every data wire into it.
      for (const edge of dataWiresRead(current, id)) wires.set(edge.id, edge);
    }
    for (const [id, edge] of wires) {
      flashWire(id, reduced);
      for (const [nodeId, pinId] of wireEnds(edge)) flashPin(nodeId, pinId, reduced);
    }
  };

  return {
    flash(event) {
      if (disposed) return;
      pending ??= { nodes: new Set(), edges: new Set() };
      for (const id of event.nodes) pending.nodes.add(id);
      for (const id of event.edges) pending.edges.add(id);
      frame ??= requestAnimationFrame(run);
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      found.clear();
    },
  };
}

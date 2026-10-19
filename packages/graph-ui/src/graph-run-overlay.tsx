import { useEffect, useState, type RefObject } from "react";
import { createRunFlasher } from "./run-flash";
import { NO_VALUE_TEXT, pinShowsValue, resolvePinValue, type GraphRunTrace, type RunGraph } from "./run-trace";

type PinTip = {
  nodeId: string;
  pinId: string;
  direction: "in" | "out";
  text: string;
  /** Viewport point the tip hangs from: the middle of the pin's side of its row. */
  x: number;
  top: number;
  bottom: number;
};

const SIDE = "[data-pin-side]";
const TIP_HALF_WIDTH = 168;
const EDGE_GAP = 8;

function sideTarget(element: EventTarget | null): Element | null {
  return element instanceof Element ? element.closest(SIDE) : null;
}

/**
 * A canvas that shows a running owner's graph. It draws what ran (`createRunFlasher`) and
 * answers a pin with its last value: hovering a pin's side of its row with a mouse, or
 * tapping its label by touch (a tap on the handle stays tap-to-connect). Both are found by
 * event delegation from the canvas element, so no node or pin renders per run, and only the
 * tip itself, which holds its own state, re-renders as the pointer moves between pins.
 */
export function GraphRunOverlay({
  root,
  trace,
  graph,
}: {
  root: RefObject<HTMLElement | null>;
  trace: GraphRunTrace;
  /** The canvas's current nodes and wires; read when a run arrives or a tip opens. */
  graph: () => RunGraph;
}) {
  const [tip, setTip] = useState<PinTip | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const flasher = createRunFlasher(element, graph);
    const unsubscribe = trace.subscribe((run) => flasher.flash(run));
    return () => {
      unsubscribe();
      flasher.dispose();
    };
  }, [root, trace, graph]);

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    let pointerType = "mouse";
    let open: Pick<PinTip, "nodeId" | "pinId" | "direction"> | null = null;

    const hide = () => {
      open = null;
      setTip(null);
    };
    const textOf = (nodeId: string, pinId: string, direction: "in" | "out") =>
      resolvePinValue(trace, graph(), nodeId, pinId, direction) ?? NO_VALUE_TEXT;
    const show = (side: Element) => {
      const nodeId = side.closest(".react-flow__node")?.getAttribute("data-id");
      const pinId = side.getAttribute("data-pin-id");
      const direction = side.getAttribute("data-pin-side");
      if (!nodeId || pinId === null || (direction !== "in" && direction !== "out") ||
        !pinShowsValue(graph(), nodeId, pinId, direction)) {
        hide();
        return;
      }
      const rect = side.getBoundingClientRect();
      open = { nodeId, pinId, direction };
      setTip({
        nodeId, pinId, direction, text: textOf(nodeId, pinId, direction),
        x: Math.min(Math.max(rect.left + rect.width / 2, TIP_HALF_WIDTH + EDGE_GAP), window.innerWidth - TIP_HALF_WIDTH - EDGE_GAP),
        top: rect.top,
        bottom: rect.bottom,
      });
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const side = sideTarget(event.target);
      if (side) show(side);
    };
    const onPointerOut = (event: PointerEvent) => {
      const side = sideTarget(event.target);
      if (!side || (event.relatedTarget instanceof Node && side.contains(event.relatedTarget))) return;
      hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerType = event.pointerType;
      // A press anywhere but a pin label ends a touch tip; the label's own tap toggles it.
      if (event.pointerType === "touch" && !(event.target instanceof Element && event.target.closest("[data-pin-label]"))) hide();
    };
    const onClick = (event: MouseEvent) => {
      if (pointerType !== "touch" || !(event.target instanceof Element)) return;
      const side = event.target.closest("[data-pin-label]") && sideTarget(event.target);
      if (!side) return;
      const nodeId = side.closest(".react-flow__node")?.getAttribute("data-id");
      if (open && nodeId === open.nodeId && side.getAttribute("data-pin-id") === open.pinId &&
        side.getAttribute("data-pin-side") === open.direction) hide();
      else show(side);
    };

    // The tip shows live values while it is open: refresh it, at most once a frame, as runs arrive.
    let refresh: number | null = null;
    const unsubscribe = trace.subscribe(() => {
      if (!open || refresh !== null) return;
      refresh = requestAnimationFrame(() => {
        refresh = null;
        if (!open) return;
        const { nodeId, pinId, direction } = open;
        const text = textOf(nodeId, pinId, direction);
        setTip((current) => current && current.text !== text ? { ...current, text } : current);
      });
    });

    element.addEventListener("pointerover", onPointerOver);
    element.addEventListener("pointerout", onPointerOut);
    element.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("click", onClick);
    element.addEventListener("wheel", hide, { passive: true });
    return () => {
      element.removeEventListener("pointerover", onPointerOver);
      element.removeEventListener("pointerout", onPointerOut);
      element.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("click", onClick);
      element.removeEventListener("wheel", hide);
      unsubscribe();
      if (refresh !== null) cancelAnimationFrame(refresh);
      open = null;
    };
  }, [root, trace, graph]);

  if (!tip) return null;
  // Above the pin, or below it where the canvas edge leaves no room.
  const above = tip.top > 48;
  return (
    <div
      role="tooltip"
      data-testid="graph-pin-value-tip"
      data-pin-id={tip.pinId}
      className="pointer-events-none fixed z-50 w-fit max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs break-words whitespace-pre-wrap text-background shadow-md"
      style={{
        left: tip.x,
        top: above ? tip.top - 6 : tip.bottom + 6,
        transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
    >
      {tip.text === "" ? "\"\"" : tip.text}
    </div>
  );
}

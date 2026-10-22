import { useEffect, useState, type RefObject } from "react";
import { humanizePropertyLabel } from "@haptic/editor-kit";
import { createRunFlasher } from "./run-flash";
import { NO_STATUS_TEXT, NO_VALUE_TEXT, pinShowsValue, resolvePinValue, type GraphRunTrace, type RunGraph } from "./run-trace";

/** What a tip is about: a data pin's last value, or a node's status. */
type TipTarget =
  | { kind: "pin"; nodeId: string; pinId: string; direction: "in" | "out" }
  | { kind: "status"; nodeId: string };

type Tip = {
  target: TipTarget;
  text: string;
  /** Viewport point the tip hangs from: the middle of the anchor's top and bottom edge. */
  x: number;
  top: number;
  bottom: number;
};

const SIDE = "[data-pin-side]";
const STATUS = "[data-run-status-tip]";
const ANCHOR = `${SIDE}, ${STATUS}`;
const TIP_HALF_WIDTH = 168;
const EDGE_GAP = 8;

function anchorAt(element: EventTarget | null): Element | null {
  return element instanceof Element ? element.closest(ANCHOR) : null;
}

function sameTarget(a: TipTarget, b: TipTarget): boolean {
  if (a.kind === "status") return b.kind === "status" && a.nodeId === b.nodeId;
  return b.kind === "pin" && a.nodeId === b.nodeId && a.pinId === b.pinId && a.direction === b.direction;
}

/**
 * A canvas that shows a running owner's graph. It draws what ran (`createRunFlasher`) and
 * answers with a tip: a data pin's last value, or a node's status where the graph reports one.
 * A mouse opens a tip by hovering its anchor (a pin's side of its row, a node's status header);
 * touch taps a pin's label (a tap on the handle stays tap-to-connect) or the status header. All
 * of it is found by event delegation from the canvas element, so no node or pin renders per run,
 * and only the tip itself, which holds its own state, re-renders as the pointer moves between
 * anchors.
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
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const flasher = createRunFlasher(element, graph);
    const unsubscribe = trace.subscribe((run) => flasher.flash(run));
    const unsubscribeHold = trace.subscribeHold?.((held) => flasher.hold(held));
    return () => {
      unsubscribe();
      unsubscribeHold?.();
      flasher.dispose();
    };
  }, [root, trace, graph]);

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    let pointerType = "mouse";
    let open: TipTarget | null = null;
    let unwatchStatus: (() => void) | null = null;

    const hide = () => {
      open = null;
      unwatchStatus?.();
      unwatchStatus = null;
      setTip(null);
    };
    const textOf = (target: TipTarget) => {
      if (target.kind === "status") {
        const status = trace.status?.(target.nodeId);
        return status ? humanizePropertyLabel(status) : NO_STATUS_TEXT;
      }
      return resolvePinValue(trace, graph(), target.nodeId, target.pinId, target.direction) ?? NO_VALUE_TEXT;
    };
    const targetOf = (anchor: Element): TipTarget | null => {
      const nodeId = anchor.closest(".react-flow__node")?.getAttribute("data-id");
      if (!nodeId) return null;
      if (anchor.matches(STATUS)) return trace.status ? { kind: "status", nodeId } : null;
      const pinId = anchor.getAttribute("data-pin-id");
      const direction = anchor.getAttribute("data-pin-side");
      if (pinId === null || (direction !== "in" && direction !== "out") ||
        !pinShowsValue(graph(), nodeId, pinId, direction)) return null;
      return { kind: "pin", nodeId, pinId, direction };
    };
    // The tip shows live values while it is open: refresh it, at most once a frame, as runs and status changes arrive.
    let refresh: number | null = null;
    const scheduleRefresh = () => {
      if (!open || refresh !== null) return;
      refresh = requestAnimationFrame(() => {
        refresh = null;
        if (!open) return;
        const text = textOf(open);
        setTip((current) => current && current.text !== text ? { ...current, text } : current);
      });
    };
    const show = (anchor: Element) => {
      const target = targetOf(anchor);
      if (!target) {
        hide();
        return;
      }
      const watching = target.kind === "status" ? trace.subscribeStatus?.(target.nodeId, scheduleRefresh) ?? null : null;
      unwatchStatus?.();
      unwatchStatus = watching;
      const rect = anchor.getBoundingClientRect();
      open = target;
      setTip({
        target, text: textOf(target),
        x: Math.min(Math.max(rect.left + rect.width / 2, TIP_HALF_WIDTH + EDGE_GAP), window.innerWidth - TIP_HALF_WIDTH - EDGE_GAP),
        top: rect.top,
        bottom: rect.bottom,
      });
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const anchor = anchorAt(event.target);
      if (anchor) show(anchor);
    };
    const onPointerOut = (event: PointerEvent) => {
      // A touch pointer leaves right after every tap, before the click that opens or toggles the tip.
      if (event.pointerType === "touch") return;
      const anchor = anchorAt(event.target);
      if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
      hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerType = event.pointerType;
      // A press anywhere but a pin label or a status header ends a touch tip; its own tap toggles it.
      if (event.pointerType === "touch" && !(event.target instanceof Element && event.target.closest(`[data-pin-label], ${STATUS}`))) hide();
    };
    const onClick = (event: MouseEvent) => {
      if (pointerType !== "touch" || !(event.target instanceof Element)) return;
      const anchor = anchorAt(event.target);
      // A pin opens from its label only; its handle stays tap-to-connect.
      if (!anchor || (anchor.matches(SIDE) && !event.target.closest("[data-pin-label]"))) return;
      const target = targetOf(anchor);
      if (target && open && sameTarget(open, target)) hide();
      else show(anchor);
    };

    const unsubscribe = trace.subscribe(scheduleRefresh);

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
      unwatchStatus?.();
      if (refresh !== null) cancelAnimationFrame(refresh);
      open = null;
    };
  }, [root, trace, graph]);

  if (!tip) return null;
  // Above the anchor, or below it where the canvas edge leaves no room.
  const above = tip.top > 48;
  const pin = tip.target.kind === "pin" ? tip.target : null;
  return (
    <div
      role="tooltip"
      data-testid={pin ? "graph-pin-value-tip" : "graph-node-status-tip"}
      data-pin-id={pin?.pinId}
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

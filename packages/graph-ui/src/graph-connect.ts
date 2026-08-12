import {
  formatEventTitle,
  humanizePropertyLabel,
} from "@babylonslate/editor-kit";
import type { PaletteNode, SerializedPin } from "./graph-types";

/** Drop closer than this to the source pin cancels Add Node. */
export const CONNECT_END_CANCEL_PX = 48;

export function displayNodeTitle(nodeType: string, title?: string): string {
  if (nodeType.startsWith("flow.event.")) {
    return formatEventTitle(
      title?.trim() || nodeType.slice("flow.event.".length),
    );
  }
  if (title && title.trim().length > 0) return title;
  return humanizePropertyLabel(nodeType.replace(/\./g, " "));
}

export function pinsAreCompatible(
  source: SerializedPin,
  target: SerializedPin,
): boolean {
  if (source.direction === target.direction) return false;
  const outgoing = source.direction === "out" ? source : target;
  const incoming = source.direction === "in" ? source : target;
  if (outgoing.kind !== incoming.kind) return false;
  if (outgoing.kind === "exec") return true;
  if (outgoing.type.kind === incoming.type.kind) return true;
  return (
    outgoing.type.kind.toLowerCase().includes("wildcard") ||
    incoming.type.kind.toLowerCase().includes("wildcard")
  );
}

export function firstCompatiblePin(
  pins: SerializedPin[] | undefined,
  dragged: SerializedPin,
): SerializedPin | undefined {
  return (pins ?? []).find((pin) => pinsAreCompatible(dragged, pin));
}

export function filterPaletteForPin(
  nodes: PaletteNode[],
  dragged: SerializedPin,
): PaletteNode[] {
  return nodes.filter((node) => firstCompatiblePin(node.pins, dragged));
}

export function isNearSourcePin(
  from: { x: number; y: number },
  to: { x: number; y: number },
  thresholdPx = CONNECT_END_CANCEL_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) < thresholdPx;
}

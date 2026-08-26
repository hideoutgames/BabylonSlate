import type { OverlayPointerHit } from "@babylonslate/core";

export type OverlayPointerPhase = "move" | "down" | "up" | "cancel";

export type OverlayPointerDispatch = {
  layerId: string;
  actorGuid: string;
  event:
    | "onMouseEnter"
    | "onMouseLeave"
    | "onClick"
    | "onPressStart"
    | "onPressEnd";
  componentId?: string;
};

export type OverlayPointerState = {
  hovered: Map<string, OverlayPointerHit>;
  pressed: Map<string, OverlayPointerHit>;
};

export function createOverlayPointerState(): OverlayPointerState {
  return {
    hovered: new Map(),
    pressed: new Map(),
  };
}

function buttonHits(
  hits: readonly OverlayPointerHit[],
): OverlayPointerHit[] {
  return hits.filter((hit) => hit.hasButton && hit.actorGuid);
}

function keyOf(hit: OverlayPointerHit): string {
  return hit.componentId
    ? `${hit.actorGuid}:${hit.componentId}`
    : hit.actorGuid;
}

function dispatchOf(
  hit: OverlayPointerHit,
  event: OverlayPointerDispatch["event"],
): OverlayPointerDispatch {
  return {
    layerId: hit.layerId,
    actorGuid: hit.actorGuid,
    event,
    ...(hit.componentId ? { componentId: hit.componentId } : {}),
  };
}

/** Hover / press state machine for overlay 2DButton actors. */
export function applyOverlayPointer(
  state: OverlayPointerState,
  phase: OverlayPointerPhase,
  hits: readonly OverlayPointerHit[],
): OverlayPointerDispatch[] {
  const buttons = buttonHits(hits);
  const nextHovered = new Map<string, OverlayPointerHit>();
  for (const hit of buttons) nextHovered.set(keyOf(hit), hit);
  const out: OverlayPointerDispatch[] = [];

  if (phase === "move") {
    for (const [guid, hit] of state.hovered) {
      if (!nextHovered.has(guid)) {
        out.push(dispatchOf(hit, "onMouseLeave"));
      }
    }
    for (const [guid, hit] of nextHovered) {
      if (!state.hovered.has(guid)) {
        out.push(dispatchOf(hit, "onMouseEnter"));
      }
    }
    state.hovered = nextHovered;
    return out;
  }

  if (phase === "down") {
    for (const [guid, hit] of state.hovered) {
      if (!nextHovered.has(guid)) {
        out.push(dispatchOf(hit, "onMouseLeave"));
      }
    }
    for (const [guid, hit] of nextHovered) {
      if (!state.hovered.has(guid)) {
        out.push(dispatchOf(hit, "onMouseEnter"));
      }
    }
    state.hovered = nextHovered;
    for (const hit of buttons) {
      out.push(dispatchOf(hit, "onPressStart"));
      state.pressed.set(keyOf(hit), hit);
    }
    return out;
  }

  for (const hit of state.pressed.values()) {
    out.push(dispatchOf(hit, "onPressEnd"));
  }
  const pressed = new Set(state.pressed.keys());
  for (const hit of buttons) {
    if (pressed.has(keyOf(hit))) {
      out.push(dispatchOf(hit, "onClick"));
    }
  }
  state.pressed.clear();
  return out;
}

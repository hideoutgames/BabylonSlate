import type { OverlayPointerHit } from "@babylonslate/core";

export type OverlayPointerPhase = "move" | "down" | "up";

export type OverlayPointerDispatch = {
  layerId: string;
  actorGuid: string;
  event:
    | "onMouseEnter"
    | "onMouseLeave"
    | "onClick"
    | "onPressStart"
    | "onPressEnd";
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
  return hit.actorGuid;
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
        out.push({
          layerId: hit.layerId,
          actorGuid: hit.actorGuid,
          event: "onMouseLeave",
        });
      }
    }
    for (const [guid, hit] of nextHovered) {
      if (!state.hovered.has(guid)) {
        out.push({
          layerId: hit.layerId,
          actorGuid: hit.actorGuid,
          event: "onMouseEnter",
        });
      }
    }
    state.hovered = nextHovered;
    return out;
  }

  if (phase === "down") {
    for (const [guid, hit] of state.hovered) {
      if (!nextHovered.has(guid)) {
        out.push({
          layerId: hit.layerId,
          actorGuid: hit.actorGuid,
          event: "onMouseLeave",
        });
      }
    }
    for (const [guid, hit] of nextHovered) {
      if (!state.hovered.has(guid)) {
        out.push({
          layerId: hit.layerId,
          actorGuid: hit.actorGuid,
          event: "onMouseEnter",
        });
      }
    }
    state.hovered = nextHovered;
    for (const hit of buttons) {
      out.push({
        layerId: hit.layerId,
        actorGuid: hit.actorGuid,
        event: "onPressStart",
      });
      state.pressed.set(keyOf(hit), hit);
    }
    return out;
  }

  for (const hit of state.pressed.values()) {
    out.push({
      layerId: hit.layerId,
      actorGuid: hit.actorGuid,
      event: "onPressEnd",
    });
  }
  const pressed = new Set(state.pressed.keys());
  for (const hit of buttons) {
    if (pressed.has(keyOf(hit))) {
      out.push({
        layerId: hit.layerId,
        actorGuid: hit.actorGuid,
        event: "onClick",
      });
    }
  }
  state.pressed.clear();
  return out;
}

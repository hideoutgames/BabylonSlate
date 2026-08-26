import { describe, expect, it } from "vitest";
import {
  applyOverlayPointer,
  createOverlayPointerState,
} from "./scene-layer-pointer";

describe("applyOverlayPointer", () => {
  it("emits enter/leave on move and click on press/release of the same actor", () => {
    const state = createOverlayPointerState();
    const button = {
      layerId: "hud",
      actorGuid: "ok",
      hitTest: "block" as const,
      hasButton: true,
    };

    expect(applyOverlayPointer(state, "move", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onMouseEnter" },
    ]);
    expect(applyOverlayPointer(state, "down", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressStart" },
    ]);
    expect(applyOverlayPointer(state, "up", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressEnd" },
      { layerId: "hud", actorGuid: "ok", event: "onClick" },
    ]);
    expect(applyOverlayPointer(state, "move", [])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onMouseLeave" },
    ]);
  });

  it("keys hover per button so two buttons on one actor do not share enter/leave", () => {
    const state = createOverlayPointerState();
    const first = {
      layerId: "hud",
      actorGuid: "ok",
      hitTest: "block" as const,
      hasButton: true,
      componentId: "btn-1",
    };
    const second = {
      layerId: "hud",
      actorGuid: "ok",
      hitTest: "block" as const,
      hasButton: true,
      componentId: "btn-2",
    };
    expect(applyOverlayPointer(state, "move", [first])).toEqual([
      {
        layerId: "hud",
        actorGuid: "ok",
        event: "onMouseEnter",
        componentId: "btn-1",
      },
    ]);
    expect(applyOverlayPointer(state, "move", [second])).toEqual([
      {
        layerId: "hud",
        actorGuid: "ok",
        event: "onMouseLeave",
        componentId: "btn-1",
      },
      {
        layerId: "hud",
        actorGuid: "ok",
        event: "onMouseEnter",
        componentId: "btn-2",
      },
    ]);
  });

  it("does not click when release misses, and skips non-button hits", () => {
    const state = createOverlayPointerState();
    const button = {
      layerId: "hud",
      actorGuid: "ok",
      hitTest: "block" as const,
      hasButton: true,
    };
    const texture = {
      layerId: "hud",
      actorGuid: "tex",
      hitTest: "block" as const,
      hasButton: false,
    };

    expect(applyOverlayPointer(state, "down", [button, texture])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onMouseEnter" },
      { layerId: "hud", actorGuid: "ok", event: "onPressStart" },
    ]);
    expect(applyOverlayPointer(state, "up", [texture])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressEnd" },
    ]);
  });
});

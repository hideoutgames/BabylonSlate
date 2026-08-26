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

  it("treats cancel over the pressed button as click, and cancel off-target as press end only", () => {
    const state = createOverlayPointerState();
    const button = {
      layerId: "hud",
      actorGuid: "ok",
      hitTest: "block" as const,
      hasButton: true,
    };

    expect(applyOverlayPointer(state, "down", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onMouseEnter" },
      { layerId: "hud", actorGuid: "ok", event: "onPressStart" },
    ]);
    expect(applyOverlayPointer(state, "cancel", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressEnd" },
      { layerId: "hud", actorGuid: "ok", event: "onClick" },
    ]);

    expect(applyOverlayPointer(state, "down", [button])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressStart" },
    ]);
    expect(applyOverlayPointer(state, "cancel", [])).toEqual([
      { layerId: "hud", actorGuid: "ok", event: "onPressEnd" },
    ]);
  });
});

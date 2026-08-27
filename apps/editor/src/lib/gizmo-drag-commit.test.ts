import { describe, expect, it } from "vitest";
import {
  createActor,
  createText2DComponent,
  identitySerializedTransform,
} from "@babylonslate/core";
import { applyLiveGizmoToActor, takeGizmoDragScene } from "./gizmo-drag-commit";

describe("takeGizmoDragScene", () => {
  it("returns the drag-start scene once and clears the ref", () => {
    const scene = { name: "Main" };
    const ref = { current: scene };
    expect(takeGizmoDragScene(ref)).toBe(scene);
    expect(ref.current).toBeNull();
  });

  it("returns null when no drag is in progress", () => {
    expect(takeGizmoDragScene({ current: null })).toBeNull();
  });
});

describe("applyLiveGizmoToActor", () => {
  const live = {
    actorId: "hud",
    position: [1, 2, 3] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };

  it("writes wrap px on 2D Text and keeps the live actor scale", () => {
    const actor = createActor("hud", "Label", {
      components: [createText2DComponent("label")],
      transform: identitySerializedTransform(),
    });
    const next = applyLiveGizmoToActor(actor, {
      ...live,
      scale: [1, 1, 1],
      text2dWrap: { wrapWidth: 400, wrapHeight: 80 },
    });
    expect(next.transform.scale).toEqual([1, 1, 1]);
    expect(next.components[0]?.properties.wrapWidth).toBe(400);
    expect(next.components[0]?.properties.wrapHeight).toBe(80);
    expect(next.transform.position).toEqual([1, 2, 3]);
  });

  it("writes actor scale for overlay panels with no wrap payload", () => {
    const actor = createActor("hud", "Panel", {
      components: [
        {
          id: "panel",
          classId: "2DPanelComponent",
          properties: {},
          parentId: null,
        },
      ],
      transform: identitySerializedTransform(),
    });
    const next = applyLiveGizmoToActor(actor, {
      ...live,
      scale: [2, 0.5, 1],
    });
    expect(next.transform.scale).toEqual([2, 0.5, 1]);
    expect(next.components[0]?.properties.wrapWidth).toBeUndefined();
  });
});

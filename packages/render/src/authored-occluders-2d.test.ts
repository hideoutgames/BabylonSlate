import { createDefaultSpritePayload } from "@haptic/assets";
import { createActor, identitySerializedTransform } from "@haptic/core";
import { describe, expect, it } from "vitest";
import { authoredOccluders2D } from "./authored-occluders-2d";

const one = { x: 1, y: 1, z: 1 };

describe("authoredOccluders2D", () => {
  it("outlines each solid Collider at its component pose and the actor's scale, skipping triggers", () => {
    const offset = identitySerializedTransform(); offset.position = [2, 0, 0];
    const actor = createActor("wall", "Wall", { components: [
      { id: "solid", classId: "ColliderComponent", properties: { shape: { kind: "box2d", halfExtents: { x: 0.5, y: 1 } } }, transform: offset },
      { id: "zone", classId: "ColliderComponent", properties: { shape: { kind: "circle", radius: 3 }, isTrigger: true } },
    ] });
    const [shape, ...rest] = authoredOccluders2D(actor, undefined, { x: 2, y: 1, z: 1 });
    expect(rest).toEqual([]);
    // Scale doubles the box's width and the offset along X, as the 2D world bakes it.
    expect(shape).toEqual({ closed: true, points: [3, -1, 5, -1, 5, 1, 3, 1] });
  });

  it("sizes a box Collider by its actor's Sprite collision box", () => {
    const sprite = { ...createDefaultSpritePayload(), width: 200, height: 100, pixelsPerUnit: 100, collision: { x: 0, y: 0, width: 0.5, height: 1 } };
    const actor = createActor("hero", "Hero", { components: [
      { id: "sprite", classId: "SpriteComponent", properties: { assetGuid: "hero" } },
      { id: "box", classId: "ColliderComponent", properties: { shape: { kind: "box2d", halfExtents: { x: 9, y: 9 } } } },
    ] });
    const [shape] = authoredOccluders2D(actor, { spritePayloads: new Map([["hero", sprite]]) }, one);
    const xs = shape!.points.filter((_, index) => index % 2 === 0);
    const ys = shape!.points.filter((_, index) => index % 2 === 1);
    // The left half of a 2 × 1 image, centred on its pivot.
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-1, 0, -0.5, 0.5]);
  });
});

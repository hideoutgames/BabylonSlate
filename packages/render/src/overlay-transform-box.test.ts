import { describe, expect, it } from "vitest";
import {
  applyOverlayBoxDrag,
  OVERLAY_BOX_MIN_SCALE,
  type OverlayBoxDragStart,
  type OverlayBoxLocalBounds,
  type OverlayBoxTransform,
} from "./overlay-transform-box";

const UNIT: OverlayBoxLocalBounds = {
  minX: -0.5,
  maxX: 0.5,
  minY: -0.5,
  maxY: 0.5,
};

function start(
  gesture: OverlayBoxDragStart["gesture"],
  pointer: { x: number; y: number },
  transform: Partial<OverlayBoxTransform> = {},
  bounds: OverlayBoxLocalBounds = UNIT,
): OverlayBoxDragStart {
  return {
    gesture,
    bounds,
    pointer,
    transform: {
      position: [0, 0, 5],
      rotationZ: 0,
      scale: [1, 1, 1],
      ...transform,
    },
  };
}

describe("applyOverlayBoxDrag move", () => {
  it("adds the pointer delta to XY and leaves Z-order unchanged", () => {
    const next = applyOverlayBoxDrag(start("move", { x: 1, y: 2 }), {
      x: 3,
      y: 5,
    });
    expect(next.position[0]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(3);
    expect(next.position[2]).toBe(5);
    expect(next.rotationZ).toBe(0);
    expect(next.scale).toEqual([1, 1, 1]);
  });

  it("snaps translated XY when snap is enabled", () => {
    const next = applyOverlayBoxDrag(
      start("move", { x: 0, y: 0 }),
      { x: 0.4, y: -0.7 },
      { enabled: true, translate: 0.5, rotateDeg: 15, scale: 0.25 },
    );
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(-0.5);
    expect(next.position[2]).toBe(5);
  });
});

describe("applyOverlayBoxDrag resize", () => {
  it("keeps the west edge fixed when dragging east", () => {
    const next = applyOverlayBoxDrag(start("e", { x: 0.5, y: 0 }), {
      x: 1.5,
      y: 0.2,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.scale[1]).toBeCloseTo(1);
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(0);
    expect(next.position[2]).toBe(5);
  });

  it("keeps the east edge fixed when dragging west", () => {
    const next = applyOverlayBoxDrag(start("w", { x: -0.5, y: 0 }), {
      x: -1.5,
      y: 0,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.position[0]).toBeCloseTo(-0.5);
    expect(next.position[1]).toBeCloseTo(0);
  });

  it("keeps the south edge fixed when dragging north", () => {
    const next = applyOverlayBoxDrag(start("n", { x: 0, y: 0.5 }), {
      x: 0,
      y: 1.5,
    });
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(0.5);
    expect(next.position[0]).toBeCloseTo(0);
  });

  it("keeps the north edge fixed when dragging south", () => {
    const next = applyOverlayBoxDrag(start("s", { x: 0, y: -0.5 }), {
      x: 0,
      y: -1.5,
    });
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[1]).toBeCloseTo(-0.5);
  });

  it("resizes both axes from a corner and keeps the opposite corner fixed", () => {
    const next = applyOverlayBoxDrag(start("se", { x: 0.5, y: -0.5 }), {
      x: 1.5,
      y: -1.5,
    });
    expect(next.scale[0]).toBeCloseTo(2);
    expect(next.scale[1]).toBeCloseTo(2);
    expect(next.position[0]).toBeCloseTo(0.5);
    expect(next.position[1]).toBeCloseTo(-0.5);
  });

  it("clamps scale to a positive minimum instead of flipping through zero", () => {
    const next = applyOverlayBoxDrag(start("e", { x: 0.5, y: 0 }), {
      x: -4,
      y: 0,
    });
    expect(next.scale[0]).toBeCloseTo(OVERLAY_BOX_MIN_SCALE);
    expect(next.scale[0]).toBeGreaterThan(0);
    expect(next.scale[1]).toBeCloseTo(1);
  });

  it("snaps resulting scale when snap is enabled", () => {
    const next = applyOverlayBoxDrag(
      start("e", { x: 0.5, y: 0 }),
      { x: 0.9, y: 0 },
      { enabled: true, translate: 1, rotateDeg: 15, scale: 0.5 },
    );
    expect(next.scale[0]).toBeCloseTo(1.5);
  });
});

describe("applyOverlayBoxDrag rotate", () => {
  it("applies Z rotation about the visual center from the pointer atan2 delta", () => {
    const next = applyOverlayBoxDrag(start("rotate", { x: 1, y: 0 }), {
      x: 0,
      y: 1,
    });
    expect(next.rotationZ).toBeCloseTo(Math.PI / 2);
    expect(next.position[0]).toBeCloseTo(0);
    expect(next.position[1]).toBeCloseTo(0);
    expect(next.position[2]).toBe(5);
    expect(next.scale).toEqual([1, 1, 1]);
  });

  it("orbits XY when the mesh origin is not the visual center", () => {
    const bounds: OverlayBoxLocalBounds = {
      minX: 0,
      maxX: 2,
      minY: -0.5,
      maxY: 0.5,
    };
    const next = applyOverlayBoxDrag(
      start("rotate", { x: 3, y: 0 }, {}, bounds),
      { x: 1, y: 2 },
    );
    expect(next.rotationZ).toBeCloseTo(Math.PI / 2);
    expect(next.position[0]).toBeCloseTo(1);
    expect(next.position[1]).toBeCloseTo(-1);
    expect(next.position[2]).toBe(5);
  });

  it("snaps rotation to rotateDeg steps", () => {
    const next = applyOverlayBoxDrag(
      start("rotate", { x: 1, y: 0 }),
      { x: Math.cos(0.2), y: Math.sin(0.2) },
      { enabled: true, translate: 1, rotateDeg: 15, scale: 0.25 },
    );
    expect(next.rotationZ).toBeCloseTo((15 * Math.PI) / 180);
  });
});

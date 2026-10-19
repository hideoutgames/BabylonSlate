import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { collisionMatrixAllows, normalizeCollisionMatrix } from "@babylonslate/core";
import { CollisionMatrixField } from "./collision-matrix-field";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(cleanup);

describe("CollisionMatrixField", () => {
  it("shows each pair once and unticks it on both layers' rows", () => {
    const onChange = vi.fn();
    const labels = ["Default", "Player", "Ghost"];
    render(<CollisionMatrixField labels={labels} value={normalizeCollisionMatrix(undefined, 3)} onChange={onChange} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.queryByRole("checkbox", { name: "Ghost Collides With Player" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Player Collides With Ghost" }));
    const next = onChange.mock.calls.at(-1)?.[0] as number[];
    expect(collisionMatrixAllows(next, 1, 2)).toBe(false);
    expect(collisionMatrixAllows(next, 2, 1)).toBe(false);
    expect(collisionMatrixAllows(next, 0, 2)).toBe(true);
  });
});

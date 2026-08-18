import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SpriteCollisionOverlay } from "./sprite-collision-overlay";

afterEach(() => {
  cleanup();
});

describe("SpriteCollisionOverlay", () => {
  it("positions the dashed AABB from normalized collision", () => {
    render(
      <div style={{ width: 100, height: 100 }}>
        <SpriteCollisionOverlay
          collision={{ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }}
          onChange={vi.fn()}
        />
      </div>,
    );
    const overlay = screen.getByTestId("sprite-collision-overlay");
    expect(overlay.style.left).toBe("10%");
    expect(overlay.style.top).toBe("20%");
    expect(overlay.style.width).toBe("50%");
    expect(overlay.style.height).toBe("40%");
    expect(screen.getByTestId("sprite-collision-handle-e")).toBeTruthy();
    expect(screen.getByTestId("sprite-collision-handle-nw")).toBeTruthy();
  });
});

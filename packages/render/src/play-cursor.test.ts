import { describe, expect, it } from "vitest";
import { attachPlayCursor } from "./play-cursor";

describe("attachPlayCursor", () => {
  it("hides the CSS cursor by default and restores it for mouse when shown", () => {
    const canvas = {
      style: { cursor: "" },
      parentElement: null,
    } as HTMLCanvasElement;
    const cursor = attachPlayCursor(canvas);
    expect(canvas.style.cursor).toBe("none");
    cursor.setVisible(true);
    cursor.notePointer("mouse", 4, 8);
    expect(canvas.style.cursor).toBe("default");
    cursor.notePointer("touch", 10, 12);
    expect(canvas.style.cursor).toBe("none");
    cursor.setVisible(false);
    expect(canvas.style.cursor).toBe("none");
    cursor.dispose();
    expect(canvas.style.cursor).toBe("");
  });

  it("does not require canvas.style (NullEngine FakeCanvas)", () => {
    const canvas = { parentElement: null } as HTMLCanvasElement;
    const cursor = attachPlayCursor(canvas);
    cursor.setVisible(true);
    cursor.notePointer("mouse", 0, 0);
    cursor.dispose();
  });
});

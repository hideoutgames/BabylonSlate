import { afterEach, describe, expect, it } from "vitest";
import { attachInputCapture } from "./input-capture";

afterEach(() => {
  document.body.replaceChildren();
});

describe("attachInputCapture input mode", () => {
  it("keeps HUD touch axes and drops keys in Interface mode", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const handle = attachInputCapture(canvas);
    handle.setInputMode("Interface");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect(handle.ring.drain()).toEqual([]);
    handle.pushTouchAxis("Jump", 1);
    expect(handle.ring.drain()).toEqual([
      expect.objectContaining({ kind: "touchAxis", controlId: "Jump", value: 1 }),
    ]);
    handle.dispose();
  });
});

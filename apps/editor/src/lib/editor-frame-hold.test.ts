import { describe, expect, it } from "vitest";
import {
  editorViewportFramesHeld,
  holdEditorViewportFrames,
  subscribeEditorViewportFrameHold,
} from "./editor-frame-hold";

describe("editor viewport frame hold", () => {
  it("stays held until the last overlapping hold ends, whichever ends first and however often", () => {
    const first = holdEditorViewportFrames();
    const seen: boolean[] = [];
    // A registry mounted during a hold starts held.
    const unsubscribe = subscribeEditorViewportFrameHold((held) => seen.push(held));
    try {
      const second = holdEditorViewportFrames();
      first();
      first();
      expect(editorViewportFramesHeld()).toBe(true);
      second();
      expect(editorViewportFramesHeld()).toBe(false);
      expect(seen).toEqual([true, false]);
    } finally {
      unsubscribe();
    }
  });
});

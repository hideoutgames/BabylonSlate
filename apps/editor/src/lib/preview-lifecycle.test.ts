import { describe, expect, it } from "vitest";
import { attachPreviewLifecycle } from "./preview-lifecycle";

it("replays native state when the preview finishes booting and removes listeners on cleanup", () => {
  const host = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let frame: EventTarget | null = null;
  const bridge = attachPreviewLifecycle(() => frame, host, visibility);
  host.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: false } }));
  host.dispatchEvent(new CustomEvent("babylonslate:audiointerruption", { detail: { type: "began" } }));
  frame = new EventTarget();
  const states: unknown[] = [];
  frame.addEventListener("babylonslate:appstate", (event) => states.push((event as CustomEvent).detail));
  frame.addEventListener("babylonslate:audiointerruption", (event) => states.push((event as CustomEvent).detail));
  bridge.sync();
  expect(states).toEqual([{ isActive: false }, { type: "began" }]);
  bridge.dispose();
  host.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: true } }));
  expect(states).toHaveLength(2);
});

describe("preview visibility", () => {
  it("keeps a hidden preview inactive when native foreground arrives", () => {
    const host = new EventTarget();
    const visibility = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const frame = new EventTarget();
    const states: boolean[] = [];
    frame.addEventListener("babylonslate:appstate", (event) => states.push((event as CustomEvent).detail.isActive));
    const bridge = attachPreviewLifecycle(() => frame, host, visibility);
    host.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: true } }));
    expect(states).toEqual([false]);
    bridge.dispose();
  });
});

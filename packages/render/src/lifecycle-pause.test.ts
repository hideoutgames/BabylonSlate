import { expect, it } from "vitest";
import { attachLifecyclePause } from "./lifecycle-pause";

it("keeps native inactivity independent of visibility and detaches on disposal", () => {
  const host = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  host.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: false } }));
  visibility.dispatchEvent(new Event("visibilitychange"));
  host.dispatchEvent(new CustomEvent("babylonslate:appstate", { detail: { isActive: true } }));
  expect(states).toEqual([false, true, true, false]);
  dispose();
  visibility.visibilityState = "hidden";
  visibility.dispatchEvent(new Event("visibilitychange"));
  expect(states).toHaveLength(4);
});

import { expect, it } from "vitest";
import { attachLifecyclePause } from "./lifecycle-pause";

function lifecycleTargets(visibilityState = "visible") {
  return {
    host: new EventTarget(),
    visibility: Object.assign(new EventTarget(), { visibilityState }),
  };
}

it("keeps native inactivity independent of visibility and detaches on disposal", () => {
  const host = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: false } }));
  visibility.dispatchEvent(new Event("visibilitychange"));
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: true } }));
  expect(states).toEqual([false, true, true, false]);
  dispose();
  visibility.visibilityState = "hidden";
  visibility.dispatchEvent(new Event("visibilitychange"));
  expect(states).toHaveLength(4);
});

it("pauses when the document hides and resumes when it shows again", () => {
  const { host, visibility } = lifecycleTargets();
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  visibility.visibilityState = "hidden";
  visibility.dispatchEvent(new Event("visibilitychange"));
  visibility.visibilityState = "visible";
  visibility.dispatchEvent(new Event("visibilitychange"));
  expect(states).toEqual([false, true, false]);
  dispose();
});

it("stays paused until both native activity and visibility allow resume", () => {
  const { host, visibility } = lifecycleTargets();
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: false } }));
  visibility.visibilityState = "hidden";
  visibility.dispatchEvent(new Event("visibilitychange"));
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: true } }));
  expect(states.at(-1)).toBe(true);
  visibility.visibilityState = "visible";
  visibility.dispatchEvent(new Event("visibilitychange"));
  expect(states.at(-1)).toBe(false);
  dispose();
});

it("starts paused when attached to a hidden document", () => {
  const { host, visibility } = lifecycleTargets("hidden");
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  expect(states).toEqual([true]);
  dispose();
});

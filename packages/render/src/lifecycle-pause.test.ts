import { expect, it } from "vitest";
import { attachLifecyclePause } from "./lifecycle-pause";

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

function visibilityTarget(visibilityState: "visible" | "hidden" = "visible") {
  return Object.assign(new EventTarget(), { visibilityState: visibilityState as string });
}

function setVisibility(visibility: { visibilityState: string } & EventTarget, state: "visible" | "hidden") {
  visibility.visibilityState = state;
  visibility.dispatchEvent(new Event("visibilitychange"));
}

it("pauses while the document is hidden and resumes when it is visible again", () => {
  const visibility = visibilityTarget();
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), new EventTarget(), visibility);
  setVisibility(visibility, "hidden");
  setVisibility(visibility, "visible");
  expect(states).toEqual([false, true, false]);
  dispose();
});

it("stays paused until both native activity and visibility allow a resume", () => {
  const host = new EventTarget();
  const visibility = visibilityTarget();
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), host, visibility);
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: false } }));
  setVisibility(visibility, "hidden");
  host.dispatchEvent(new CustomEvent("haptic:appstate", { detail: { isActive: true } }));
  expect(states.at(-1)).toBe(true);
  setVisibility(visibility, "visible");
  expect(states.at(-1)).toBe(false);
  dispose();
});

it("starts paused when attached to a hidden document", () => {
  const states: boolean[] = [];
  const dispose = attachLifecyclePause((paused) => states.push(paused), new EventTarget(), visibilityTarget("hidden"));
  expect(states).toEqual([true]);
  dispose();
});

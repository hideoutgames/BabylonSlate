import { describe, expect, it } from "vitest";
import { ClassRegistry, World } from "@haptic/object-model";
import { InputResolver, type InputMappings, type RawInputEvent } from "@haptic/input";
import type { FocusNavigationSettings } from "@haptic/core";
import { SceneLayerFocusNavigation } from "./scene-layer-focus";

const key = (code: string, phase: "down" | "up"): RawInputEvent => ({ kind: "key", tick: 0, code, phase });
const tap = (code: string) => [key(code, "down"), key(code, "up")];
function fixture(settings?: Partial<FocusNavigationSettings>, mappings: InputMappings = { actions: [], axes: [] }) {
  const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
  const layer = world.createSceneLayer({ assetGuid: "menu", zOrder: 0 });
  const events: string[] = [];
  const notReady = new Set<string>();
  /** The actor of every admission check the navigation made, in order. */
  const canRunCalls: string[] = [];
  const resolver = new InputResolver(mappings);
  const navigation = new SceneLayerFocusNavigation(world, settings, {
    canRun: (actor) => (canRunCalls.push(actor.guid), !notReady.has(actor.sceneLayerId!)),
    event: (_actor, component, event) => events.push(`${component.guid}:${event}`),
  });
  const add = (id: string, x: number, y: number, properties: Record<string, unknown> = {}, layerId = layer.guid) => {
    const actor = world.createActor({ guid: id, classId: "SceneLayerActor", sceneLayerId: layerId });
    actor.transform.position = { x, y, z: 0 };
    const component = world.createComponent({ guid: `${id}-focus`, classId: "2DButtonComponent", variables: properties });
    actor.attachComponent(component);
    world.spawnActorNow(actor);
    return { actor, component };
  };
  const tick = (events: RawInputEvent[] = [], dt = 0.1) => navigation.tick(events, resolver.resolve(events, dt), dt);
  return { world, layer, navigation, events, notReady, canRunCalls, add, tick, resolver };
}

describe("SceneLayer focus navigation", () => {
  it("walks only the topmost layer with a candidate, and falls to the next layer when that one has none", () => {
    const f = fixture();
    const middle = f.world.createSceneLayer({ assetGuid: "pause", zOrder: 5 });
    const top = f.world.createSceneLayer({ assetGuid: "dialog", zOrder: 9 });
    // Spawned interleaved, so world order differs from layer order.
    const low1 = f.add("low-1", 0, 0);
    const dialogA = f.add("dialog-a", 0, 0, {}, top.guid);
    const mid1 = f.add("mid-1", 0, 0, {}, middle.guid);
    const low2 = f.add("low-2", 3, 0, { focusInitial: true });
    const dialogB = f.add("dialog-b", 3, 0, { focusInitial: true }, top.guid);
    const low3 = f.add("low-3", 6, 0);
    f.tick();
    expect(f.navigation.getFocused()).toBe(dialogB.component);
    // An idle tick with the focus in the topmost layer revalidates the focused target alone: it admits its actor once,
    // never the owning layer's other actor or the four under it.
    f.canRunCalls.length = 0;
    f.tick();
    expect(f.canRunCalls).toEqual(["dialog-b"]);
    // Tab order is the owning layer's targets in world order.
    expect(f.navigation.advance(true)).toBe(dialogA.component);
    // With the top layer's targets gone, the next layer down owns navigation: the walk goes that far and no further.
    dialogA.component.setVariable("enabled", false);
    dialogB.component.setVariable("enabled", false);
    f.tick();
    expect(f.navigation.advance()).toBe(mid1.component);
    f.canRunCalls.length = 0;
    f.tick();
    expect(f.canRunCalls).toEqual(["dialog-a", "dialog-b", "mid-1"]);
    // Then the bottom layer, with its own initial target and its targets in world order.
    mid1.actor.setVariable("visible", false);
    f.tick();
    expect(f.navigation.getFocused()).toBe(low2.component);
    expect(f.navigation.advance(true)).toBe(low1.component);
    expect(f.navigation.advance()).toBe(low2.component);
    expect(f.navigation.advance()).toBe(low3.component);
  });

  it("revalidates the focus on idle ticks from the focused target, and still loses it to whatever the full walk would", () => {
    // The breaks: an idle tick that rebuilds every candidate's transform and bounds, or one that keeps a focus the walk
    // would drop (a hidden target, a layer drawn above it) or reads a moved target's old bounds.
    const f = fixture();
    let measured: string[] = [];
    const navigation = new SceneLayerFocusNavigation(f.world, undefined, {
      canRun: () => true,
      event: (_actor, component, event) => f.events.push(`${component.guid}:${event}`),
      bounds: (actor) => (measured.push(actor.guid), { x: actor.transform.position.x, y: 0, width: 1, height: 1 }),
    });
    const tick = (events: RawInputEvent[] = []) => navigation.tick(events, f.resolver.resolve(events, 0.1), 0.1);
    const a = f.add("a", 0, 0, { focusInitial: true });
    const b = f.add("b", 3, 0);
    const c = f.add("c", 6, 0);
    tick();
    expect(navigation.getFocused()).toBe(a.component);
    measured = [];
    tick();
    tick();
    expect(measured).toEqual(["a", "a"]);
    // Moved while idle, the focus keeps its new place: the next move starts from there.
    a.actor.transform.position = { x: 7, y: 0, z: 0 };
    tick();
    tick(tap("ArrowLeft"));
    expect(navigation.getFocused()).toBe(c.component);
    // Hidden on an idle tick, the focus is lost there, as the walk loses it.
    c.actor.setVariable("visible", false);
    tick();
    expect(f.events.slice(-1)).toEqual(["c-focus:onFocusLeave"]);
    expect(navigation.getFocused()).toBeNull();
    // A layer drawn above takes navigation on the first idle tick it has a target.
    c.actor.setVariable("visible", true);
    navigation.setFocus(b.component);
    const dialog = f.world.createSceneLayer({ assetGuid: "dialog", zOrder: 9 });
    const ok = f.add("ok", 0, 0, { focusInitial: true }, dialog.guid);
    tick();
    expect(navigation.getFocused()).toBe(ok.component);
  });

  it("gives a target under the owning layer its first focused value once, when it can first take focus", () => {
    const f = fixture();
    const top = f.world.createSceneLayer({ assetGuid: "dialog", zOrder: 9 });
    const waiting = f.world.createSceneLayer({ assetGuid: "loading", zOrder: 1 });
    const orphaned = "no-such-layer";
    const owner = f.add("owner", 0, 0, {}, top.guid);
    const lower = f.add("lower", 0, 0);
    const disabled = f.add("disabled", 3, 0, { enabled: false });
    const unfocusable = f.add("unfocusable", 6, 0, { focusEnabled: false });
    const notReady = f.add("not-ready", 0, 0, {}, waiting.guid);
    const stray = f.add("stray", 0, 0, {}, orphaned);
    f.notReady.add(waiting.guid);
    const focused = (target: { component: { getVariable(name: string): unknown } }) => target.component.getVariable("focused");
    for (const target of [owner, lower, disabled, unfocusable, notReady, stray]) expect(focused(target)).toBeUndefined();
    f.tick();
    expect([owner, lower, stray].map(focused)).toEqual([false, false, false]);
    expect([disabled, unfocusable, notReady].map(focused)).toEqual([undefined, undefined, undefined]);
    // Each gets its value on the tick it becomes able to take focus, though its layer is never walked.
    disabled.component.setVariable("enabled", true);
    f.tick();
    expect([disabled, unfocusable, notReady].map(focused)).toEqual([false, undefined, undefined]);
    f.notReady.delete(waiting.guid);
    unfocusable.component.setVariable("focusEnabled", true);
    f.tick();
    expect([disabled, unfocusable, notReady].map(focused)).toEqual([false, false, false]);
    // Once every target has a value, an idle tick admits the owning layer's actor alone.
    f.canRunCalls.length = 0;
    f.tick();
    expect(f.canRunCalls).toEqual(["owner"]);
    // A value written since (a script's own flag) is left alone.
    lower.component.setVariable("focused", true);
    f.tick();
    expect(focused(lower)).toBe(true);
    // A target attached later, under the owning layer, is reached too.
    const late = f.add("late", 9, 0);
    f.tick();
    expect(focused(late)).toBe(false);
  });

  it("keeps quick direction and activate taps and dispatches the focused button's events exactly once", () => {
    const f = fixture();
    const a = f.add("a", 0, 0, { focusInitial: true });
    const b = f.add("b", 3, 0);
    f.tick();
    f.tick([...tap("ArrowRight"), ...tap("Enter")]);
    f.tick();
    expect(a.component.getVariable("focused")).toBe(false);
    expect(b.component.getVariable("focused")).toBe(true);
    expect(f.events).toEqual([
      "a-focus:onFocusEnter", "a-focus:onFocusLeave", "b-focus:onFocusEnter",
      "b-focus:onPressStart", "b-focus:onPressEnd", "b-focus:onFocusActivate", "b-focus:onClick",
    ]);
    f.navigation.clearFocus(b.component);
    f.tick();
    expect(f.navigation.getFocused()).toBeNull();
  });

  it("reaches focus targets spawned or attached after navigation started", () => {
    const f = fixture();
    const a = f.add("a", 0, 0, { focusInitial: true });
    f.tick();
    expect(f.navigation.getFocused()).toBe(a.component);
    const b = f.add("b", 3, 0);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(b.component);
    const attached = f.world.createComponent({ guid: "b-next", classId: "2DButtonComponent" });
    attached.transform.position = { x: 3, y: 0, z: 0 };
    b.actor.attachComponent(attached);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(attached);
  });

  it("moves immediately on a same-direction repress and restarts the repeat delay", () => {
    const f = fixture({ repeatDelay: 0.4, repeatInterval: 0.1 });
    f.add("a", 0, 0, { focusInitial: true });
    const b = f.add("b", 2, 0), c = f.add("c", 4, 0), d = f.add("d", 6, 0);
    f.tick(); f.tick([key("ArrowRight", "down")]);
    expect(f.navigation.getFocused()).toBe(b.component);
    f.tick([], 0.2);
    f.tick([key("ArrowRight", "up"), key("ArrowRight", "down")]);
    expect(f.navigation.getFocused()).toBe(c.component);
    f.tick([], 0.3);
    expect(f.navigation.getFocused()).toBe(c.component);
    f.tick([], 0.11);
    expect(f.navigation.getFocused()).toBe(d.component);
  });

  it("ends a previous activation before a rapid repress and retains the new held press", () => {
    const f = fixture();
    f.add("a", 0, 0, { focusInitial: true });
    f.tick(); f.tick([key("Enter", "down")]);
    f.tick([key("Enter", "up"), key("Enter", "down")]);
    expect(f.events).toEqual([
      "a-focus:onFocusEnter", "a-focus:onPressStart", "a-focus:onPressEnd", "a-focus:onFocusActivate", "a-focus:onClick", "a-focus:onPressStart",
    ]);
    f.tick([key("Enter", "up")]);
    expect(f.events.slice(-3)).toEqual(["a-focus:onPressEnd", "a-focus:onFocusActivate", "a-focus:onClick"]);
    expect(f.events.filter(event => event === "a-focus:onClick")).toHaveLength(2);
  });

  it("uses nested component positions and an explicit neighbor before automatic spatial choice", () => {
    const f = fixture();
    const start = f.add("start", 0, 0, { focusInitial: true });
    const other = f.add("other", 1, 0);
    const nested = f.world.createComponent({ guid: "nested", classId: "2DFocusTargetComponent", parentId: start.component.guid });
    nested.transform.position.x = -2;
    start.actor.attachComponent(nested);
    f.tick();
    f.tick(tap("ArrowLeft"));
    expect(f.navigation.getFocused()).toBe(nested);
    nested.setVariable("focusRight", other.component.guid);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(other.component);
    other.component.setVariable("focusLeft", "missing");
    f.tick(tap("ArrowLeft"));
    expect(f.navigation.getFocused()).toBe(other.component);
  });

  it("skips hidden and disabled ancestors and cancels activation when a pressed target disappears", () => {
    const f = fixture();
    const a = f.add("a", 0, 0, { focusInitial: true });
    const hidden = f.add("hidden", 1, 0);
    hidden.actor.setVariable("visible", false);
    const child = f.add("child", 0, 0);
    child.actor.setVariable("parentId", hidden.actor.guid);
    const disabled = f.add("disabled", 2, 0, { enabled: false });
    const b = f.add("b", 3, 0);
    f.tick();
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(b.component);
    f.tick([key("Enter", "down")]);
    b.component.destroyed = true;
    f.tick([key("Enter", "up")]);
    expect(f.navigation.getFocused()).toBeNull();
    expect(f.events.some((event) => event.endsWith(":onClick"))).toBe(false);
    expect(f.navigation.setFocus(child.component)).toBe(false);
    expect(f.navigation.setFocus(disabled.component)).toBe(false);
    expect(a.component.getVariable("focused")).toBe(false);
  });

  it("keeps prefab component neighbor links within each instance, including an unavailable sibling", () => {
    const f = fixture();
    const first = f.add("first", 0, 0);
    const second = f.add("second", 5, 0);
    const neighbors = [first, second].map(({ actor, component }) => {
      component.sourceId = "start";
      component.setVariable("focusRight", "next");
      const neighbor = f.world.createComponent({ guid: `${actor.guid}-next`, sourceId: "next", classId: "2DFocusTargetComponent" });
      neighbor.transform.position.x = 2;
      actor.attachComponent(neighbor);
      return neighbor;
    });
    f.navigation.setFocus(second.component);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(neighbors[1]);
    f.navigation.setFocus(second.component);
    neighbors[1]!.setVariable("enabled", false);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(second.component);
    second.component.setVariable("focusRight", neighbors[0]!.guid);
    f.tick(tap("ArrowRight"));
    expect(f.navigation.getFocused()).toBe(neighbors[0]);
  });

  it("isolates navigation to the highest ready layer and cannot follow an explicit cross-layer link", () => {
    const f = fixture();
    const a = f.add("a", 0, 0, { focusInitial: true });
    const modal = f.world.createSceneLayer({ assetGuid: "modal", zOrder: 3 });
    const b = f.add("b", 2, 0, { focusInitial: true, focusLeft: a.component.guid }, modal.guid);
    f.notReady.add(modal.guid);
    f.tick();
    expect(f.navigation.getFocused()).toBe(a.component);
    f.notReady.delete(modal.guid);
    f.tick();
    expect(f.navigation.getFocused()).toBe(b.component);
    f.tick(tap("ArrowLeft"));
    expect(f.navigation.getFocused()).toBe(b.component);
    expect(f.navigation.setFocus(a.component)).toBe(false);
    b.actor.destroyed = true;
    f.tick();
    expect(f.navigation.getFocused()).toBe(a.component);
  });

  it("advances Tab through the top ready layer only, skipping disabled focus and respecting wrapping", () => {
    const f = fixture();
    const background = f.add("background", 0, 0);
    const modal = f.world.createSceneLayer({ assetGuid: "modal", zOrder: 3 });
    const first = f.add("first", 0, 0, {}, modal.guid);
    f.add("excluded", 1, 0, { focusEnabled: false }, modal.guid);
    f.add("disabled", 2, 0, { enabled: false }, modal.guid);
    const last = f.add("last", 3, 0, {}, modal.guid);
    f.notReady.add(modal.guid);
    expect(f.navigation.advance()).toBe(background.component);
    f.notReady.delete(modal.guid);
    expect(f.navigation.advance()).toBe(first.component);
    expect(f.navigation.advance()).toBe(last.component);
    expect(f.navigation.advance()).toBe(last.component);
    expect(f.navigation.advance(true)).toBe(first.component);
    f.navigation.clearFocus();
    expect(f.navigation.advance(true)).toBe(last.component);
    const wrapped = fixture({ wrap: true });
    const a = wrapped.add("a", 0, 0), b = wrapped.add("b", 1, 0);
    expect(wrapped.navigation.advance(true)).toBe(b.component);
    expect(wrapped.navigation.advance()).toBe(a.component);
  });

  it("does not admit Tab focus when project navigation is disabled", () => {
    const f = fixture({ enabled: false });
    f.add("control", 0, 0, { focusInitial: true });
    expect(f.navigation.advance()).toBeNull();
    expect(f.events).toEqual([]);
  });

  it("repeats held gamepad directions on the configured delay, wraps, and activates generic focus targets", () => {
    const f = fixture({ repeatDelay: 0.3, repeatInterval: 0.1, wrap: true });
    const a = f.add("a", 0, 0, { focusInitial: true });
    const b = f.add("b", 2, 0);
    const c = f.add("c", 4, 0);
    // A separate nonvisual target participates without adding button pointer behavior.
    c.component.destroyed = true;
    const target = f.world.createComponent({ guid: "generic", classId: "2DFocusTargetComponent" });
    c.actor.attachComponent(target);
    const pad = (x: number, button = 0): RawInputEvent => ({ kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [x, 0], buttons: [button] });
    f.tick();
    f.tick([pad(1)]);
    expect(f.navigation.getFocused()).toBe(b.component);
    f.tick([], 0.2);
    expect(f.navigation.getFocused()).toBe(b.component);
    f.tick([], 0.11);
    expect(f.navigation.getFocused()).toBe(target);
    f.tick([pad(0, 1)]);
    f.tick([pad(0, 0)]);
    expect(f.events).toContain("generic:onFocusActivate");
    expect(f.events).not.toContain("generic:onClick");
    f.tick([pad(1)]);
    expect(f.navigation.getFocused()).toBe(a.component);
  });

  it("uses selected input assets instead of built-in bindings, including a complete custom axis tap", () => {
    const f = fixture({ navigationInputGuid: "nav", activateInputGuid: "accept" }, {
      actions: [{ id: "accept", name: "Accept", bindings: [{ device: "key", code: "KeyF" }] }],
      axes: [{ id: "nav", name: "Menu", kind: "2d", bindings: [{ device: "key", code: "KeyL", component: "x" }] }],
    });
    const a = f.add("a", 0, 0, { focusInitial: true });
    const b = f.add("b", 2, 0);
    f.tick();
    f.tick([...tap("ArrowRight"), ...tap("Enter")]);
    expect(f.navigation.getFocused()).toBe(a.component);
    expect(f.events.some((event) => event.endsWith(":onClick"))).toBe(false);
    f.tick([...tap("KeyL"), ...tap("KeyF")]);
    expect(f.navigation.getFocused()).toBe(b.component);
    expect(f.events).toContain("b-focus:onClick");
  });
});

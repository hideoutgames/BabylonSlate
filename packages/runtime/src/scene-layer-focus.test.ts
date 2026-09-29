import { describe, expect, it } from "vitest";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { InputResolver, type InputMappings, type RawInputEvent } from "@babylonslate/input";
import type { FocusNavigationSettings } from "@babylonslate/core";
import { SceneLayerFocusNavigation } from "./scene-layer-focus";

const key = (code: string, phase: "down" | "up"): RawInputEvent => ({ kind: "key", tick: 0, code, phase });
const tap = (code: string) => [key(code, "down"), key(code, "up")];
function fixture(settings?: Partial<FocusNavigationSettings>, mappings: InputMappings = { actions: [], axes: [] }) {
  const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
  const layer = world.createSceneLayer({ assetGuid: "menu", zOrder: 0 });
  const events: string[] = [];
  const notReady = new Set<string>();
  const resolver = new InputResolver(mappings);
  const navigation = new SceneLayerFocusNavigation(world, settings, {
    canRun: (actor) => !notReady.has(actor.sceneLayerId!),
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
  return { world, layer, navigation, events, notReady, add, tick, resolver };
}

describe("SceneLayer focus navigation", () => {
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

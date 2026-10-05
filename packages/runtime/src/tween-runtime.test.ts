import { describe, expect, it } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { TweenRuntime, type TweenRequest } from "./tween-runtime";

function floatRequest(values: unknown[], identity = {}): TweenRequest {
  return { reference: { identity, property: "amount", set: value => { values.push(value); } },
    type: "float", a: 2, b: 10, duration: 2, curve: "linear" };
}

describe("simulation-owned tweens", () => {
  it("writes the initial, intermediate and exact final value and completes only at the endpoint", async () => {
    const runtime = new TweenRuntime(), values: unknown[] = [];
    let completed = false;
    const pending = runtime.start(floatRequest(values)).then(result => { completed = result; });
    expect(values).toEqual([2]);
    runtime.advance(0.5);
    expect(values).toEqual([2, 4]);
    await Promise.resolve();
    expect(completed).toBe(false);
    runtime.advance(2);
    await pending;
    expect(values).toEqual([2, 4, 10]);
    expect(completed).toBe(true);
    runtime.advance(1);
    expect(values).toHaveLength(3);
  });

  it("captures endpoints and waits for both calling and target owners to be admitted", async () => {
    const caller = new Actor({ classId: "Actor" }), target = new Actor({ classId: "Actor" });
    const admitted = new Set([caller]);
    const runtime = new TweenRuntime(owner => !owner || admitted.has(owner as Actor));
    const values: unknown[] = [], a = { x: 1, y: 2 }, b = { x: 5, y: 6 };
    const pending = runtime.start({ ...floatRequest(values), owner: caller, type: "vec2", a, b,
      reference: { ...floatRequest(values).reference, owner: target } });
    a.x = 100; b.y = 100;
    runtime.advance(10);
    expect(values).toEqual([]);
    admitted.add(target);
    runtime.advance(1);
    expect(values).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    admitted.delete(caller);
    runtime.advance(10);
    expect(values).toHaveLength(2);
    admitted.add(caller);
    runtime.advance(1);
    expect(await pending).toBe(true);
    expect(values.at(-1)).toEqual({ x: 5, y: 6 });
  });

  it("replaces overlapping channels on the same storage and preserves unrelated actions", async () => {
    const runtime = new TweenRuntime(), identity = {}, oldValues: unknown[] = [], x: unknown[] = [], other: unknown[] = [];
    const compound = floatRequest(oldValues, identity);
    compound.reference.channels = ["x", "y"];
    const old = runtime.start(compound);
    const independent = runtime.start(floatRequest(other, {}));
    const replacement = floatRequest(x, identity);
    replacement.reference.property = "x";
    const next = runtime.start(replacement);
    expect(await old).toBe(false);
    runtime.advance(2);
    expect(await next).toBe(true);
    expect(await independent).toBe(true);
    expect(oldValues).toEqual([2]);
    expect(x).toEqual([2, 10]);
    expect(other).toEqual([2, 10]);
  });

  it("cancels a component action when its actor is destroyed and unwinds all actions on stop", async () => {
    const runtime = new TweenRuntime(), actor = new Actor({ classId: "Actor" });
    const component = new ActorComponent({ classId: "2DTextComponent" }); actor.attachComponent(component);
    const values: unknown[] = [], request = floatRequest(values);
    request.reference.owner = component;
    const pending = runtime.start(request);
    actor.destroyed = true;
    runtime.cancelInvalid();
    expect(await pending).toBe(false);
    runtime.advance(10);
    expect(values).toEqual([2]);
    const other = runtime.start(floatRequest(values));
    runtime.stop();
    expect(await other).toBe(false);
    expect(await runtime.start(floatRequest(values))).toBe(false);
  });

  it("snaps nonpositive durations and rejects invalid values without disturbing a valid action", async () => {
    const runtime = new TweenRuntime(), values: unknown[] = [], request = floatRequest(values);
    const pending = runtime.start(request);
    expect(await runtime.start({ ...request, b: Number.NaN })).toBe(false);
    runtime.advance(2);
    expect(await pending).toBe(true);
    expect(await runtime.start({ ...request, duration: -1 })).toBe(true);
    expect(values).toEqual([2, 10, 10]);
  });

  it("cancels refused writes and rejects setter errors without poisoning other tweens", async () => {
    const runtime = new TweenRuntime(), values: unknown[] = [], request = floatRequest(values);
    const refused = runtime.start({ ...request, reference: { ...request.reference, set: () => false } });
    expect(await refused).toBe(false);
    const broken = runtime.start({ ...request, reference: { ...request.reference, set: () => { throw new Error("write failed"); } } });
    await expect(broken).rejects.toThrow("write failed");
    const healthy = runtime.start(request);
    runtime.advance(2);
    expect(await healthy).toBe(true);
  });
});

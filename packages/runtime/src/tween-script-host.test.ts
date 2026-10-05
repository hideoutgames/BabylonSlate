import { describe, expect, it, vi } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { identityTransform } from "@babylonslate/core";
import { ScriptHost, type ScriptHostServices } from "./script-host";
import { TweenRuntime } from "./tween-runtime";

function harness() {
  const tweens = new TweenRuntime();
  const actor = new Actor({ classId: "Actor", guid: "owner" });
  const refresh = vi.fn(), teleport = vi.fn();
  const services: ScriptHostServices = {
    log: () => {}, print: () => {}, destroyActor: () => {}, executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError: error => { throw error; }, tween: request => tweens.start(request),
    refreshComponent: refresh, teleportActor: teleport, findActor: id => id === actor.guid ? actor : undefined,
  };
  const host = new ScriptHost(services);
  const ctx = host.createContext(actor, 0.5, 1);
  const component = (classId: string, variables: Record<string, unknown> = {}) => {
    const object = new ActorComponent({ classId, variables }); actor.attachComponent(object); return object;
  };
  return { actor, component, tweens, ctx, refresh, teleport };
}

describe("Tween script targets", () => {
  it("writes retained scalar references and native color storage through the property refresh path", async () => {
    const { ctx, component, tweens, actor, refresh } = harness();
    const text = component("2DTextComponent", { color: [1, 1, 1] });
    const scalar = ctx.tweenValue(ctx.variableReference(null, "score"), "float", 10, 20, 2, "linear");
    const color = ctx.tweenValue(ctx.variableReference(text, "color"), "color", [1, 0, 0], [0, 0, 1], 2, "linear");
    tweens.advance(1);
    expect(actor.getVariable("score")).toBe(15);
    expect(text.getVariable("color")).toEqual([0.5, 0, 0.5]);
    expect(refresh).toHaveBeenLastCalledWith(text, "color");
    tweens.advance(1);
    expect(await scalar).toBe(true); expect(await color).toBe(true);
    expect(ctx.variableReference(component("2DRichTextComponent"), "appearProgress")).toBeNull();
  });

  it("makes named property tweens and ordinary writable references replace each other", async () => {
    const { ctx, component, tweens } = harness();
    const text = component("2DTextComponent", { size: 12 });
    const named = ctx.tweenProperty(text, "text.fontSize", "float", 12, 20, 2, "linear");
    const ref = ctx.tweenValue(ctx.variableReference(text, "size"), "float", 8, 16, 2, "linear");
    expect(await named).toBe(false);
    tweens.advance(1);
    expect(text.getVariable("size")).toBe(12);
    tweens.advance(1); expect(await ref).toBe(true);
  });

  it("updates compound layout/text/anchor fields together and respects content sizing", async () => {
    const { ctx, component, tweens, refresh } = harness();
    const box = component("2DOverlayBoxComponent", { widthMode: "fixed", heightMode: "content", width: 4, height: 3 });
    const text = component("2DRichTextComponent"), anchor = component("2DAnchorComponent");
    const pending = [
      ctx.tweenProperty(box, "layout.size", "vec2", { x: 4, y: 3 }, { x: 8, y: 9 }, 2, "linear"),
      ctx.tweenProperty(text, "text.wrapSize", "vec2", { x: 100, y: 40 }, { x: 300, y: 80 }, 2, "linear"),
      ctx.tweenProperty(anchor, "anchor.offset", "vec2", { x: -4, y: -2 }, { x: 4, y: 6 }, 2, "linear"),
    ];
    tweens.advance(1);
    expect(box.getVariable("width")).toBe(6); expect(box.getVariable("height")).toBe(3);
    expect(text.getVariable("wrapWidth")).toBe(200); expect(text.getVariable("wrapHeight")).toBe(60);
    expect(anchor.getVariable("offsetX")).toBe(0); expect(anchor.getVariable("offsetY")).toBe(2);
    expect(refresh).toHaveBeenCalledWith(text, "text.wrapSize");
    tweens.advance(1); expect(await Promise.all(pending)).toEqual([true, true, true]);
  });

  it("clamps opacity overshoot while keeping independent tint animation", async () => {
    const { ctx, component, tweens } = harness();
    const text = component("2DRichTextComponent");
    const opacity = ctx.tweenProperty(text, "overlay.opacity", "float", 0, 1, 2, "backOut");
    const tint = ctx.tweenProperty(text, "overlay.tint", "color", [1, 0, 0, 1], [0, 1, 0, 1], 2, "linear");
    tweens.advance(1.5);
    expect(text.getVariable("opacity")).toBe(1);
    expect(text.getVariable("tint")).toEqual([0.25, 0.75, 0, 1]);
    tweens.advance(0.5); expect(await opacity).toBe(true); expect(await tint).toBe(true);
    expect(await ctx.tweenProperty(component("MovementComponent"), "overlay.opacity", "float", 0, 1, 1, "linear")).toBe(false);
  });

  it("routes actor writes through physics and component transforms through render refresh", async () => {
    const { ctx, actor, component, tweens, refresh, teleport } = harness();
    const mesh = component("MeshComponent");
    const a = identityTransform(), b = identityTransform(); b.position.x = 4; b.scale.y = 3;
    const transform = ctx.tweenProperty(actor, "actor.transform", "transform", a, b, 2, "linear", "local");
    const position = ctx.tweenProperty(mesh, "component.position", "vec3", { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 2, "linear", "world");
    tweens.advance(1);
    expect(actor.transform.position.x).toBe(2);
    expect(actor.transform.scale.y).toBe(2);
    expect(mesh.transform.position.x).toBe(2);
    expect(teleport).toHaveBeenCalledWith(actor);
    expect(refresh).toHaveBeenCalledWith(mesh, "transform");
    const replacement = ctx.tweenProperty(actor, "actor.scale", "vec3", { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }, 0, "linear");
    expect(await transform).toBe(false); expect(await replacement).toBe(true);
    tweens.advance(1); expect(await position).toBe(true);
  });
});

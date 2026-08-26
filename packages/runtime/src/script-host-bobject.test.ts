import { describe, expect, it } from "vitest";
import {
  Actor,
  ActorComponent,
} from "@babylonslate/object-model";
import { ScriptHost, type ScriptHostServices } from "./script-host";

function stubServices(
  extras: Partial<ScriptHostServices> = {},
): ScriptHostServices {
  return {
    log: () => {},
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {},
    reportError: () => {},
    ...extras,
  };
}

describe("ScriptHost BObject receivers", () => {
  it("still moves an Actor through the narrowed transform API", () => {
    const actor = new Actor({ classId: "Hero" });
    const ctx = new ScriptHost(stubServices()).createContext(actor, 0, 0);
    ctx.setActorLocation(actor, { x: 4, y: 5, z: 6 });
    expect(actor.transform.position).toEqual({ x: 4, y: 5, z: 6 });
    ctx.setActorRotation(actor, { pitch: 0, yaw: 90, roll: 0 });
    expect(actor.transform.rotation.w).not.toBe(1);
    ctx.setActorScale(actor, { x: 2, y: 2, z: 2 });
    expect(actor.transform.scale).toEqual({ x: 2, y: 2, z: 2 });
    expect(ctx.getComponent(actor, "MeshComponent")).toBeNull();
  });

  it("sets Anim Graph variables only on the wired AnimationGraphComponent", () => {
    const actor = new Actor({ classId: "Hero" });
    const first = new ActorComponent({ classId: "AnimationGraphComponent" });
    const second = new ActorComponent({ classId: "AnimationGraphComponent" });
    actor.attachComponent(first);
    actor.attachComponent(second);
    first.setVariable("flag", "a");
    second.setVariable("flag", "b");
    const ctx = new ScriptHost(stubServices()).createContext(actor, 0, 0);
    ctx.setAnimGraphVariable(second, "flag", "wired");
    expect(first.getVariable("flag")).toBe("a");
    expect(second.getVariable("flag")).toBe("wired");
    expect(ctx.getAnimGraphVariable(first, "flag")).toBe("a");
    expect(ctx.getAnimGraphVariable(second, "flag")).toBe("wired");
    ctx.setAnimGraphVariable(actor, "flag", "ignored");
    expect(first.getVariable("flag")).toBe("a");
    expect(second.getVariable("flag")).toBe("wired");
  });

  it("resolves getComponentById by live guid and remapped sourceId", () => {
    const actor = new Actor({ classId: "Hero" });
    const text = new ActorComponent({
      classId: "Text3DComponent",
      guid: "live-id",
      sourceId: "text-1",
    });
    actor.attachComponent(text);
    const ctx = new ScriptHost(stubServices()).createContext(actor, 0, 0);
    expect(ctx.getComponentById(actor, "live-id")).toBe(text);
    expect(ctx.getComponentById(actor, "text-1")).toBe(text);
    expect(ctx.getComponentById(actor, "missing")).toBeNull();
  });

  it("dispatches a prefab-bound entry when Play invokes the remapped live guid", async () => {
    const logs: string[] = [];
    const host = new ScriptHost(
      stubServices({
        log: (_severity, category) => {
          logs.push(category);
        },
      }),
    );
    await host.load({
      assetGuid: "hero-script",
      classId: "Hero",
      source:
        'export function onHit(ctx) { ctx.log("log", "Hit", "ok"); }\n',
      anchors: [],
      entryPoints: [
        {
          name: "onHit",
          event: "onHit",
          isAsync: false,
          componentId: "prefab-col",
        },
      ],
    });
    const actor = new Actor({ classId: "Hero" });
    actor.attachComponent(
      new ActorComponent({
        classId: "ColliderComponent",
        guid: "live-col",
        sourceId: "prefab-col",
      }),
    );
    host.invokeEvent("Hero", "onHit", actor, {}, "live-col");
    expect(logs).toEqual(["Hit"]);
  });

  it("does not run leftover unbound component events when invoke carries a component id", async () => {
    const logs: string[] = [];
    const host = new ScriptHost(
      stubServices({
        log: (_severity, category) => {
          logs.push(category);
        },
      }),
    );
    await host.load({
      assetGuid: "hero-script",
      classId: "Hero",
      source: [
        'export function onHit(ctx) { ctx.log("log", "Unbound", "ok"); }',
        'export function onHit_2(ctx) { ctx.log("log", "Bound", "ok"); }',
        'export function onBeginPlay(ctx) { ctx.log("log", "Play", "ok"); }',
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onHit", event: "onHit", isAsync: false },
        {
          name: "onHit_2",
          event: "onHit",
          isAsync: false,
          componentId: "prefab-col",
        },
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
      ],
    });
    const actor = new Actor({ classId: "Hero" });
    actor.attachComponent(
      new ActorComponent({
        classId: "ColliderComponent",
        guid: "live-col",
        sourceId: "prefab-col",
      }),
    );
    host.invokeEvent("Hero", "onHit", actor, {}, "live-col");
    expect(logs).toEqual(["Bound"]);
    host.invokeEvent("Hero", "onBeginPlay", actor);
    expect(logs).toEqual(["Bound", "Play"]);
  });
});

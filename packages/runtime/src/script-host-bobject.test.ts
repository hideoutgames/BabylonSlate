import { describe, expect, it } from "vitest";
import {
  Actor,
  ActorComponent,
  ClassRegistry,
  UserInterface,
  Widget,
  interfaceHandlerKey,
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
  it("reads and writes variables on a UserInterface the same way as an Actor", () => {
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
      variables: { score: 1 },
    });
    const ctx = new ScriptHost(stubServices()).createContext(ui, 0, 0);
    expect(ctx.self).toBe(ui);
    expect(ctx.getVariable("score")).toBe(1);
    ctx.setVariable("score", 4);
    expect(ui.getVariable("score")).toBe(4);
    expect(ctx.getVariableFrom(ui, "score")).toBe(4);
    ctx.setVariableOn(ui, "score", 9);
    expect(ui.getVariable("score")).toBe(9);
  });

  it("dispatches custom events and functions on a UserInterface receiver", async () => {
    const messages: string[] = [];
    const host = new ScriptHost(
      stubServices({
        log: (_severity, _category, message) => {
          messages.push(message);
        },
      }),
    );
    await host.load({
      assetGuid: "hud-logic",
      classId: "UserInterface:hud",
      source: [
        "//# sourceURL=babylonslate:///hud-logic.js",
        "export function onPing(ctx) { ctx.log('log', 'UI', ctx.args.note); }",
        "export function addScore(ctx) { return { value: Number(ctx.args.amount) + 1 }; }",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [{ name: "onPing", event: "onPing", isAsync: false }],
    });
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
    });
    const ctx = host.createContext(ui, 0, 0);
    ctx.invokeCustomEvent(ui, "onPing", { note: "hello-ui" });
    expect(messages).toEqual(["hello-ui"]);
    expect(ctx.invokeFunction(ui, "addScore", { amount: 3 })).toEqual({
      value: 4,
    });
  });

  it("binds interface handlers on a UserInterface and dispatches through callInterface", async () => {
    const registry = new ClassRegistry();
    const host = new ScriptHost(
      stubServices({
        classRegistry: registry,
        interfaceRegistry: {
          get: () => ({
            guid: "iface-1",
            name: "HudApi",
            methods: [{ name: "Ping", outputs: { ok: false } }],
          }),
        } as never,
      }),
    );
    await host.load({
      assetGuid: "hud-iface",
      classId: "UserInterface:hud",
      source: [
        "//# sourceURL=babylonslate:///hud-iface.js",
        "export function Ping(ctx) { return { ok: true, widgetId: ctx.args.widgetId }; }",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [],
      interfaceImplementations: [
        { interfaceGuid: "iface-1", method: "Ping", exportName: "Ping" },
      ],
    });
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
      implementedInterfaces: ["iface-1"],
    });
    host.bindInterfaceHandlers(ui);
    expect(ui.interfaceHandlers.has(interfaceHandlerKey("iface-1", "Ping"))).toBe(
      true,
    );
    const ctx = host.createContext(ui, 0, 0);
    expect(ctx.callInterface(ui, "iface-1", "Ping", { widgetId: "play-btn" })).toEqual({
      ok: true,
      widgetId: "play-btn",
    });
  });

  it("narrows actor-only transform, physics, and component APIs when self is a UserInterface", () => {
    const impulses: unknown[] = [];
    const moves: unknown[] = [];
    const host = new ScriptHost(
      stubServices({
        addImpulse: (actor, impulse) => {
          impulses.push({ actor, impulse });
        },
        moveCharacter: (actor, translation) => {
          moves.push({ actor, translation });
        },
      }),
    );
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
    });
    const ctx = host.createContext(ui, 0.016, 1);
    expect(() => {
      ctx.setActorLocation(ui, { x: 1, y: 2, z: 3 });
      ctx.addImpulse(ui, { x: 1, y: 0, z: 0 }, 2);
      ctx.moveCharacter(ui, { x: 1, y: 0, z: 0 });
      ctx.destroyActor(ui);
    }).not.toThrow();
    expect(ctx.getComponent(ui, "MeshComponent")).toBeNull();
    expect(ctx.addComponent(ui, "MeshComponent")).toBeNull();
    expect(impulses).toEqual([]);
    expect(moves).toEqual([]);
  });

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

  it("does not rotate or scale a UserInterface through actor transform writes", () => {
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
    });
    const ctx = new ScriptHost(stubServices()).createContext(ui, 0, 0);
    expect(() => {
      ctx.setActorRotation(ui, { pitch: 10, yaw: 20, roll: 30 });
      ctx.setActorScale(ui, { x: 2, y: 2, z: 2 });
      ctx.setActorTransform(ui, {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 2, y: 2, z: 2 },
      });
    }).not.toThrow();
  });

  it("getWidget is scoped to a UserInterface self and ignores Widget receivers", () => {
    const ui = new UserInterface({
      classId: "UserInterface:hud",
      assetGuid: "hud",
    });
    const button = new Widget({
      classId: "ButtonWidget",
      widgetId: "play-btn",
      owner: ui,
    });
    ui.widgets.push(button);
    const host = new ScriptHost(stubServices());
    const uiCtx = host.createContext(ui, 0, 0);
    expect(uiCtx.getWidget("play-btn")).toBe(button);
    expect(uiCtx.getWidget("missing")).toBeNull();
    const actorCtx = host.createContext(new Actor({ classId: "Hero" }), 0, 0);
    expect(actorCtx.getWidget("play-btn")).toBeNull();
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
});

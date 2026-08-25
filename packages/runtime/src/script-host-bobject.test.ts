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
});

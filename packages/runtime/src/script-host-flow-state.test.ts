import { describe, expect, it } from "vitest";
import { Actor } from "@babylonslate/object-model";
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

describe("ScriptHost flowState", () => {
  it("keeps per-actor flow state isolated (never shared module globals)", () => {
    const host = new ScriptHost(stubServices());
    const a = new Actor({ classId: "Hero", guid: "a1" });
    const b = new Actor({ classId: "Hero", guid: "a2" });
    const ctxA = host.createContext(a, 0, 0);
    const ctxB = host.createContext(b, 0, 0);
    ctxA.flowState("doOnce1").done = true;
    expect(ctxB.flowState("doOnce1").done).toBeUndefined();
    expect(ctxA.flowState("doOnce1").done).toBe(true);
  });

  it("keeps identical node ids isolated between compiled scripts", () => {
    const host = new ScriptHost(stubServices());
    const actor = new Actor({ classId: "Hero", guid: "hero" });
    const first = host.createContext(
      actor,
      0,
      0,
      {},
      undefined,
      undefined,
      "script-a",
    );
    const second = host.createContext(
      actor,
      0,
      0,
      {},
      undefined,
      undefined,
      "script-b",
    );

    first.flowState("gate").open = true;
    expect(second.flowState("gate").open).toBeUndefined();
  });

  it("clears flow state when the actor is destroyed via host hooks", async () => {
    const host = new ScriptHost(stubServices());
    await host.load({
      assetGuid: "hero-logic",
      classId: "Hero",
      source: [
        "//# sourceURL=babylonslate:///hero-logic.js",
        "export function onBeginPlay(ctx) { ctx.flowState('gate1').open = true; }",
        "export function onDestroyed(ctx) { /* host clears around lifecycle */ }",
        "",
      ].join("\n"),
      anchors: [],
      entryPoints: [
        { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        { name: "onDestroyed", event: "onDestroyed", isAsync: false },
      ],
    });
    const actor = new Actor({ classId: "Hero", guid: "hero" });
    const hooks = host.hooksFor("Hero")!;
    hooks.onCreation?.(actor);
    expect(
      host
        .createContext(
          actor,
          0,
          0,
          {},
          undefined,
          undefined,
          "hero-logic",
        )
        .flowState("gate1").open,
    ).toBe(true);
    hooks.onDestroyed?.(actor);
    expect(
      host
        .createContext(
          actor,
          0,
          0,
          {},
          undefined,
          undefined,
          "hero-logic",
        )
        .flowState("gate1").open,
    ).toBeUndefined();
  });
});

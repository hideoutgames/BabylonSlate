import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createDefaultCameraShakePayload, normalizeCameraShakePayload, type CameraShakePayload } from "@haptic/core";
import { SceneLayer } from "@haptic/object-model";
import { CameraShakes } from "./camera-shakes";
import { createCameraShakeHostBindings } from "./runtime-camera-shakes";
import { ScriptHost } from "./script-host";

/** A one-second, 1 Hz sine roll of 10 degrees with no blends: roll is 10 · sin(2π t). */
function sineRoll(overrides: Partial<CameraShakePayload> = {}): CameraShakePayload {
  return normalizeCameraShakePayload({
    ...createDefaultCameraShakePayload(),
    pattern: "sine", duration: 1, blendInTime: 0, blendOutTime: 0,
    locationAmplitude: { x: 0, y: 0, z: 0 }, rotationAmplitude: { pitch: 0, yaw: 0, roll: 10 },
    rotationFrequency: { pitch: 1, yaw: 1, roll: 1 }, fovAmplitude: 0,
    ...overrides,
  });
}

function fixture(options: { view?: { x: number; y: number; z: number } | null; layers?: Set<string> } = {}) {
  const commands: Extract<CommandMessage, { type: "setCameraShake" }>[] = [];
  const layers = options.layers ?? new Set<string>();
  const shakes = new CameraShakes({
    emit: (command) => { if (command.type === "setCameraShake") commands.push(command); },
    viewLocation: () => options.view ?? null,
    hasLayer: (guid) => layers.has(guid),
    seed: () => 1,
  });
  const rolls = () => commands.map((command) => command.offset === null ? null : Number(command.offset.roll.toFixed(6)));
  return { shakes, commands, layers, rolls };
}

describe("CameraShakes", () => {
  it("sends the view's offset each tick it changes and clears it once the shake ends", () => {
    const f = fixture();
    const id = f.shakes.play(sineRoll(), {});
    expect(id).toBe(1);
    f.shakes.advance(0.25, false);
    f.shakes.advance(0.25, false);
    f.shakes.advance(0.5, false);
    f.shakes.advance(0.25, false);
    expect(f.rolls()).toEqual([10, 0, null]);
    expect(f.commands.every((command) => command.sceneLayerId === null)).toBe(true);
    expect(f.shakes.isPlaying(id)).toBe(false);
    f.shakes.advance(0.25, false);
    expect(f.commands).toHaveLength(3);
  });

  it("holds a paused shake and every shake while the game is paused, and scales and sums shakes", () => {
    const f = fixture();
    const first = f.shakes.play(sineRoll({ duration: 0 }), {}, { scale: 2 });
    f.shakes.advance(0.25, false);
    f.shakes.setPaused(first, true);
    f.shakes.advance(0.25, false);
    expect(f.shakes.isPaused(first)).toBe(true);
    f.shakes.setPaused(first, false);
    f.shakes.advance(0.25, true);
    // Paused and game-paused ticks moved nothing, so nothing new was sent.
    expect(f.rolls()).toEqual([20]);
    f.shakes.setScale(first, 1);
    f.shakes.play(sineRoll({ duration: 0 }), {});
    f.shakes.advance(0.125, false);
    // First at 0.375 s (sin = √½), the second at 0.125 s (sin = √½): 10·√½ each.
    expect(f.rolls().at(-1)).toBeCloseTo(20 * Math.SQRT1_2, 5);
    expect(f.shakes.play(sineRoll(), {}, { scale: 0 })).toBe(0);
  });

  it("blends a stopped shake out, or ends it at once when Immediately", () => {
    const f = fixture();
    const shake = sineRoll({ duration: 0, blendOutTime: 1, rotationFrequency: { pitch: 0, yaw: 0, roll: 0.25 } });
    const id = f.shakes.play(shake, {});
    f.shakes.advance(1, false);
    f.shakes.stop(id);
    f.shakes.advance(0.5, false);
    expect(f.shakes.isPlaying(id)).toBe(true);
    // At 1.5 s roll is 10·sin(0.75π) = 10·√½, halfway out of the blend.
    expect(f.rolls().at(-1)).toBeCloseTo(5 * Math.SQRT1_2, 5);
    f.shakes.advance(0.5, false);
    expect(f.shakes.isPlaying(id)).toBe(false);
    expect(f.rolls().at(-1)).toBeNull();
    const second = f.shakes.play(shake, {});
    f.shakes.advance(1, false);
    f.shakes.stopAll(true);
    expect(f.shakes.isPlaying(second)).toBe(false);
  });

  it("weakens a world shake with the view's distance from its epicenter", () => {
    const view = { x: 4, y: 0, z: 0 };
    const f = fixture({ view });
    f.shakes.play(sineRoll({ duration: 0 }), {}, { world: { epicenter: { x: 0, y: 0, z: 0 }, inner: 2, outer: 6, falloff: 1 } });
    f.shakes.advance(0.25, false);
    view.x = 10;
    f.shakes.advance(1, false);
    expect(f.rolls()).toEqual([5, 0]);
  });

  it("shakes a Scene Layer's view apart from the main view and ends with the layer", () => {
    const f = fixture({ layers: new Set(["hud"]) });
    expect(f.shakes.play(sineRoll(), {}, { target: "gone" })).toBe(0);
    const id = f.shakes.play(sineRoll({ duration: 0 }), {}, { target: "hud" });
    f.shakes.advance(0.25, false);
    expect(f.commands.at(-1)).toMatchObject({ sceneLayerId: "hud", offset: { roll: 10 } });
    f.layers.delete("hud");
    f.shakes.advance(0.25, false);
    expect(f.shakes.isPlaying(id)).toBe(false);
    // The removed layer's view is gone with it: nothing more is sent for it.
    expect(f.commands).toHaveLength(1);
  });

  it("plays shake assets from the session catalog through the script nodes' members", () => {
    const f = fixture({ layers: new Set(["hud"]) });
    const warnings: string[] = [];
    const ctx = new ScriptHost({
      log: () => {}, print: () => {}, destroyActor: () => {}, reportError: () => {}, delay: async () => {},
      executeConsoleCommand: () => ({ success: true, output: "" }),
      ...createCameraShakeHostBindings({
        shakes: f.shakes,
        catalog: new Map([["hit", { payload: sineRoll({ duration: 0, intensityCurveGuid: "half" }) }]]),
        curves: new Map([["half", { payload: { curve: { Keys: [{ Time: 0, Value: 0.5, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 }], Before: "constant", After: "constant" } } }]]),
        warn: (message) => warnings.push(message),
      }),
    }).createContext(null, 0, 0);
    const handle = ctx.playCameraShake("hit", 1);
    expect(handle).toEqual({ Id: 1 });
    expect([ctx.playCameraShake("missing", 1), ctx.playCameraShake("missing", 1)]).toEqual([{ Id: 0 }, { Id: 0 }]);
    expect(warnings).toEqual([expect.stringContaining("is not loaded")]);
    f.shakes.advance(0.25, false);
    // The Intensity Curve halves the 10° roll.
    expect(f.rolls()).toEqual([5]);
    ctx.setCameraShakePaused(handle, true);
    expect([ctx.isCameraShakePlaying(handle), ctx.isCameraShakePaused(handle)]).toEqual([true, true]);
    ctx.stopCameraShake(handle, true);
    expect(ctx.isCameraShakePlaying(handle)).toBe(false);

    const layer = new SceneLayer({ guid: "hud", assetGuid: "hud-asset", zOrder: 0 });
    expect(ctx.playCameraShakeOnSceneLayer(layer, "hit", 1)).toEqual({ Id: 2 });
    expect(ctx.playCameraShakeOnSceneLayer(null, "hit", 1)).toEqual({ Id: 0 });
    expect(ctx.playWorldCameraShake("hit", { x: 0, y: 0, z: 0 }, 0, 10, 1)).toEqual({ Id: 3 });
    expect(ctx.playWorldCameraShake("hit", { x: 0, y: 0, z: 0 }, 0, Number.NaN, 1)).toEqual({ Id: 0 });
    for (const stale of [handle, { Id: 0 }, null]) {
      ctx.setCameraShakeScale(stale, 2);
      ctx.stopCameraShake(stale, false);
    }
    expect([ctx.isCameraShakePlaying({ Id: 2 }), ctx.isCameraShakePlaying({ Id: 3 })]).toEqual([true, true]);
    ctx.stopAllCameraShakes(true);
    expect([ctx.isCameraShakePlaying({ Id: 2 }), ctx.isCameraShakePlaying({ Id: 3 })]).toEqual([false, false]);
  });
});

import { describe, expect, it } from "vitest";
import { createDefaultTilemapPayload, normalizeTilesetPayload } from "@babylonslate/assets";
import { isPlayEngineCommandType } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

describe("Tilemap animation clock", () => {
  it("uses simulation time through pause, step, dilation and paused asset reload", () => {
    const times: number[] = [];
    const content = {
      tilemaps: { map: createDefaultTilemapPayload() },
      tilesets: { atlas: normalizeTilesetPayload({ atlasWidth: 32, tiles: [{ id: 1, animation: [1, 2] }] }) },
    };
    const runtime = createInProcessRuntime({
      seed: 1, dt: 0.1, seedDemoActors: false, preferSoftwarePhysics: true, ...content,
      onCommand: (command) => {
        if (command.type === "tilemapAnimationTime" && isPlayEngineCommandType(command.type)) times.push(command.elapsedMs);
      },
    });
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    expect(times.at(-1)).toBe(100);
    runtime.pause();
    runtime.tick();
    expect(times.at(-1)).toBe(100);
    expect(runtime.executeConsoleCommand("step").success).toBe(true);
    expect(times.at(-1)).toBe(200);
    runtime.tick();
    expect(times.at(-1)).toBe(200);
    runtime.registerTileContent(content);
    expect(times.at(-1)).toBe(200);
    expect(runtime.executeConsoleCommand("slomo 0.5").success).toBe(true);
    runtime.resume();
    runtime.tick();
    expect(times.at(-1)).toBe(250);
    runtime.stop();
  });

  it("does not send animation commands for static tile content", () => {
    const times: number[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      tilemaps: { map: createDefaultTilemapPayload() },
      tilesets: { atlas: normalizeTilesetPayload({}) },
      onCommand: (command) => { if (command.type === "tilemapAnimationTime") times.push(command.elapsedMs); },
    });
    runtime.realizePlayWorld();
    runtime.start();
    runtime.tick();
    expect(times).toEqual([]);
    runtime.stop();
  });
});

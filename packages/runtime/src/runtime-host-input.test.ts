import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import type { ResolvedInputTick } from "@haptic/input";
import { createWorldInputProvider } from "./runtime-host-input";

function provider() {
  const commands: CommandMessage[] = [];
  const input = createWorldInputProvider({
    resolved: () => ({}) as ResolvedInputTick,
    connections: { current: [] },
    frameId: () => 7,
    emit: (command) => commands.push(command),
    requestDeviceMotion: () => {},
    calibrateTilt: () => {},
  });
  return { input, commands };
}

describe("createWorldInputProvider", () => {
  it("sends gamepad rumble to the host with a bounded intensity and duration", () => {
    const { input, commands } = provider();
    input.setGamepadRumble?.(1, 0.75, 250);
    input.setGamepadRumble?.(0, 4, -10);
    input.setGamepadRumble?.(0, Number.NaN, Number.POSITIVE_INFINITY);
    expect(commands).toEqual([
      { type: "setGamepadRumble", gamepadIndex: 1, intensity: 0.75, durationMs: 250, frameId: 7 },
      { type: "setGamepadRumble", gamepadIndex: 0, intensity: 1, durationMs: 0, frameId: 7 },
      { type: "setGamepadRumble", gamepadIndex: 0, intensity: 0, durationMs: 0, frameId: 7 },
    ]);
  });

  it("sends no rumble for an index no pad can have", () => {
    const { input, commands } = provider();
    input.setGamepadRumble?.(-1, 1, 100);
    input.setGamepadRumble?.(0.5, 1, 100);
    expect(commands).toEqual([]);
  });
});

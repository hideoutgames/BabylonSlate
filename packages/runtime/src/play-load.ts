import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import {
  createInProcessRuntime,
  type RuntimeDriver,
  type RuntimeDriverOptions,
} from "./driver";

export type PlayLoadControl = Extract<ControlMessage, { type: "load" }>;

/**
 * Map a worker `load` control message onto `createInProcessRuntime` physics
 * options so Play's scene settings actually reach the backend factory.
 */
export function runtimeOptionsFromLoadControl(
  msg: PlayLoadControl,
): Pick<
  RuntimeDriverOptions,
  "seed" | "physicsWorld" | "gravity" | "havokWasmUrl"
> {
  return {
    seed: msg.seed ?? 1,
    physicsWorld: msg.physicsWorld === "2d" ? "2d" : "3d",
    gravity: msg.gravity ?? [0, -9.81, 0],
    havokWasmUrl: msg.havokWasmUrl,
  };
}

/** Create the in-process driver the game worker uses after a `load` message. */
export function createRuntimeFromLoad(
  msg: PlayLoadControl,
  onCommand: (command: CommandMessage) => void,
): RuntimeDriver {
  return createInProcessRuntime({
    ...runtimeOptionsFromLoadControl(msg),
    onCommand,
  });
}

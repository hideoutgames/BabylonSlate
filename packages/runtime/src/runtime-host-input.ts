import type { CommandMessage } from "@haptic/bridge";
import type { ResolvedInputTick } from "@haptic/input";
import type { WorldInputProvider } from "@haptic/object-model";

interface WorldInputDeps {
  /** This tick's resolved input, replaced every tick. */
  resolved(): ResolvedInputTick;
  /** Mutable box so the provider reads connections without aliasing the driver. */
  connections: { readonly current: ResolvedInputTick["gamepadConnections"] };
  frameId(): number;
  emit(command: CommandMessage): void;
  /** Ask the host, once, to start device motion input. */
  requestDeviceMotion(): void;
  calibrateTilt(): void;
}

/** The World's input provider, which TickContext input reads go through. */
export function createWorldInputProvider(deps: WorldInputDeps): WorldInputProvider {
  const { resolved, connections } = deps;
  return {
    isActionHeld: (action) => resolved().actions[action]?.held ?? false,
    wasActionPressed: (action) =>
      resolved().actions[action]?.pressed ?? false,
    wasActionReleased: (action) =>
      resolved().actions[action]?.released ?? false,
    getPressedKeys: () => resolved().pressedKeys,
    getAxis: (axis) => resolved().axes[axis] ?? 0,
    getAxis2D: (axis) => resolved().axes2D[axis] ?? { x: 0, y: 0 },
    getCursorPosition: () => resolved().cursor,
    getTouches: () => resolved().touches,
    getTouchEvents: () => resolved().touchEvents,
    getDeviceMotion: () => {
      deps.requestDeviceMotion();
      return resolved().deviceMotion;
    },
    calibrateTilt: () => {
      deps.requestDeviceMotion();
      deps.calibrateTilt();
    },
    setCursorVisible: (visible) => {
      deps.emit({
        type: "setCursorVisible",
        visible: visible === true,
        frameId: deps.frameId(),
      });
    },
    get gamepadConnections() {
      return connections.current;
    },
    setGamepadRumble: (gamepadIndex, intensity, durationMs) => {
      // Only a real pad index can rumble; a bad intensity or duration stops it.
      if (!Number.isInteger(gamepadIndex) || gamepadIndex < 0) return;
      deps.emit({
        type: "setGamepadRumble",
        gamepadIndex,
        intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0,
        durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
        frameId: deps.frameId(),
      });
    },
  };
}

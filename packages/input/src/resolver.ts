import type { RawInputEvent } from "./ring-buffer";
import type {
  ActionBinding,
  AxisBinding,
  BindingModifiers,
  InputMappings,
} from "./mappings";

export interface ActionState {
  pressed: boolean;
  released: boolean;
  held: boolean;
}

export interface Axis2DValue {
  x: number;
  y: number;
}

export interface GamepadConnectionEvent {
  gamepadIndex: number;
  connected: boolean;
}

export interface ResolvedInputTick {
  actions: Record<string, ActionState>;
  axes: Record<string, number>;
  axes2D: Record<string, Axis2DValue>;
  gamepadConnections: GamepadConnectionEvent[];
}

interface ModifierState {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

interface ResolverInternals {
  heldKeys: Set<string>;
  heldMouseButtons: Set<number>;
  heldPointerButtons: Set<number>;
  heldGamepadButtons: Set<string>;
  gamepadAxes: Map<string, number>;
  touchAxes: Map<string, number>;
  connectedPads: Set<number>;
  modifiers: ModifierState;
  previousHeldActions: Set<string>;
}

function modifiersMatch(
  required: BindingModifiers | undefined,
  state: ModifierState,
): boolean {
  if (!required) return true;
  if (required.shift === true && !state.shift) return false;
  if (required.ctrl === true && !state.ctrl) return false;
  if (required.alt === true && !state.alt) return false;
  if (required.meta === true && !state.meta) return false;
  return true;
}

function applyAxisShape(raw: number, binding: AxisBinding): number {
  let value = raw;
  const deadZone = binding.deadZone ?? 0;
  if (Math.abs(value) < deadZone) {
    value = 0;
  } else if (deadZone > 0 && deadZone < 1) {
    // Remap the live range onto [-1, 1] so a stick resting at the dead-zone
    // edge does not produce a sudden jump.
    const sign = Math.sign(value);
    value = ((Math.abs(value) - deadZone) / (1 - deadZone)) * sign;
  }
  if (binding.invert) value = -value;
  value *= binding.scale ?? 1;
  value *= binding.sensitivity ?? 1;
  return value;
}

function actionBindingHeld(
  binding: ActionBinding,
  state: ResolverInternals,
): boolean {
  if (!binding.code) return false;
  if (!modifiersMatch(binding.modifiers, state.modifiers)) return false;
  switch (binding.device) {
    case "key":
      return state.heldKeys.has(binding.code);
    case "mouseButton":
      return state.heldMouseButtons.has(Number(binding.code));
    case "pointer":
      return state.heldPointerButtons.has(
        binding.code === "primary" ? 0 : Number(binding.code),
      );
    case "gamepadButton":
      return state.heldGamepadButtons.has(binding.code);
    case "touch":
      return (state.touchAxes.get(binding.code) ?? 0) > 0.5;
    case "gamepadAxis":
      return Math.abs(state.gamepadAxes.get(binding.code) ?? 0) > 0.5;
    default:
      return false;
  }
}

function axisBindingValue(
  binding: AxisBinding,
  state: ResolverInternals,
): number {
  if (!binding.code) return 0;
  if (!modifiersMatch(binding.modifiers, state.modifiers)) return 0;
  switch (binding.device) {
    case "key":
    case "mouseButton":
    case "pointer":
    case "gamepadButton": {
      const held = actionBindingHeld(
        {
          device: binding.device,
          code: binding.code,
          modifiers: binding.modifiers,
        },
        state,
      );
      if (!held) return 0;
      return applyAxisShape(binding.digitalValue ?? 1, binding);
    }
    case "touch": {
      const raw = state.touchAxes.get(binding.code) ?? 0;
      return applyAxisShape(raw, binding);
    }
    case "gamepadAxis": {
      const raw = state.gamepadAxes.get(binding.code) ?? 0;
      return applyAxisShape(raw, binding);
    }
    default:
      return 0;
  }
}

function updateModifiers(code: string, down: boolean, state: ResolverInternals): void {
  switch (code) {
    case "ShiftLeft":
    case "ShiftRight":
      state.modifiers.shift = down;
      break;
    case "ControlLeft":
    case "ControlRight":
      state.modifiers.ctrl = down;
      break;
    case "AltLeft":
    case "AltRight":
      state.modifiers.alt = down;
      break;
    case "MetaLeft":
    case "MetaRight":
      state.modifiers.meta = down;
      break;
    default:
      break;
  }
}

/**
 * Stateful fold of raw tick-stamped events into per-tick action / axis values.
 * Pure with respect to the browser: feed it synthetic streams from the
 * deterministic harness (engineplan §11.1).
 */
export class InputResolver {
  private readonly state: ResolverInternals = {
    heldKeys: new Set(),
    heldMouseButtons: new Set(),
    heldPointerButtons: new Set(),
    heldGamepadButtons: new Set(),
    gamepadAxes: new Map(),
    touchAxes: new Map(),
    connectedPads: new Set(),
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    previousHeldActions: new Set(),
  };

  private mappings: InputMappings;

  constructor(mappings: InputMappings) {
    this.mappings = mappings;
  }

  setMappings(mappings: InputMappings): void {
    this.mappings = mappings;
  }

  /** Apply one tick's events and return the resolved action / axis snapshot. */
  resolve(events: readonly RawInputEvent[]): ResolvedInputTick {
    const connections: GamepadConnectionEvent[] = [];

    for (const event of events) {
      switch (event.kind) {
        case "key": {
          const down = event.phase === "down";
          updateModifiers(event.code, down, this.state);
          if (down) this.state.heldKeys.add(event.code);
          else this.state.heldKeys.delete(event.code);
          break;
        }
        case "mouse": {
          if (event.phase === "down") {
            this.state.heldMouseButtons.add(event.button);
          } else if (event.phase === "up" || event.phase === "cancel") {
            this.state.heldMouseButtons.delete(event.button);
          }
          break;
        }
        case "pointer": {
          if (event.phase === "down") {
            this.state.heldPointerButtons.add(event.button);
          } else if (event.phase === "up" || event.phase === "cancel") {
            this.state.heldPointerButtons.delete(event.button);
          }
          break;
        }
        case "gamepad": {
          const pad = event.gamepadIndex;
          if (!this.state.connectedPads.has(pad)) {
            this.state.connectedPads.add(pad);
            connections.push({ gamepadIndex: pad, connected: true });
          }
          for (let i = 0; i < event.buttons.length; i++) {
            const key = `${pad}:${i}`;
            if ((event.buttons[i] ?? 0) > 0.5) {
              this.state.heldGamepadButtons.add(key);
            } else {
              this.state.heldGamepadButtons.delete(key);
            }
          }
          for (let i = 0; i < event.axes.length; i++) {
            this.state.gamepadAxes.set(`${pad}:${i}`, event.axes[i] ?? 0);
          }
          break;
        }
        case "gamepadConnection": {
          if (event.connected) {
            if (!this.state.connectedPads.has(event.gamepadIndex)) {
              this.state.connectedPads.add(event.gamepadIndex);
              connections.push({
                gamepadIndex: event.gamepadIndex,
                connected: true,
              });
            }
          } else if (this.state.connectedPads.delete(event.gamepadIndex)) {
            connections.push({
              gamepadIndex: event.gamepadIndex,
              connected: false,
            });
            for (const key of [...this.state.heldGamepadButtons]) {
              if (key.startsWith(`${event.gamepadIndex}:`)) {
                this.state.heldGamepadButtons.delete(key);
              }
            }
            for (const key of [...this.state.gamepadAxes.keys()]) {
              if (key.startsWith(`${event.gamepadIndex}:`)) {
                this.state.gamepadAxes.delete(key);
              }
            }
          }
          break;
        }
        case "touchAxis": {
          this.state.touchAxes.set(event.controlId, event.value);
          break;
        }
        default:
          break;
      }
    }

    const actions: Record<string, ActionState> = {};
    const heldNow = new Set<string>();
    for (const mapping of this.mappings.actions) {
      const held = mapping.bindings.some((binding) =>
        actionBindingHeld(binding, this.state),
      );
      const wasHeld = this.state.previousHeldActions.has(mapping.name);
      actions[mapping.name] = {
        held,
        pressed: held && !wasHeld,
        released: !held && wasHeld,
      };
      if (held) heldNow.add(mapping.name);
    }
    this.state.previousHeldActions = heldNow;

    const axes: Record<string, number> = {};
    const axes2D: Record<string, Axis2DValue> = {};
    for (const mapping of this.mappings.axes) {
      if (mapping.kind === "2d") {
        let x = 0;
        let y = 0;
        for (const binding of mapping.bindings) {
          const value = axisBindingValue(binding, this.state);
          if (binding.component === "y") y += value;
          else x += value;
        }
        axes2D[mapping.name] = {
          x: Math.max(-1, Math.min(1, x)),
          y: Math.max(-1, Math.min(1, y)),
        };
        // A 2D axis is also readable as its magnitude for getAxis callers.
        axes[mapping.name] = Math.hypot(axes2D[mapping.name]!.x, axes2D[mapping.name]!.y);
      } else {
        let total = 0;
        for (const binding of mapping.bindings) {
          total += axisBindingValue(binding, this.state);
        }
        axes[mapping.name] = Math.max(-1, Math.min(1, total));
      }
    }

    return {
      actions,
      axes,
      axes2D,
      gamepadConnections: connections,
    };
  }

  isActionHeld(action: string): boolean {
    return this.state.previousHeldActions.has(action);
  }

  reset(): void {
    this.state.heldKeys.clear();
    this.state.heldMouseButtons.clear();
    this.state.heldPointerButtons.clear();
    this.state.heldGamepadButtons.clear();
    this.state.gamepadAxes.clear();
    this.state.touchAxes.clear();
    this.state.connectedPads.clear();
    this.state.previousHeldActions.clear();
    this.state.modifiers = { shift: false, ctrl: false, alt: false, meta: false };
  }
}

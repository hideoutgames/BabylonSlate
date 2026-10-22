import {
  inputKeyFromControl,
  type InputKey,
  type InputTypeValue,
  type InputValueState,
  type TouchInput,
  type TouchType,
} from "@haptic/core";
import { inputMappingKey } from "./input-assets";
import type { PointerKind, RawInputEvent } from "./ring-buffer";
import { GestureRecognizer, TOUCH_PULSE_GESTURES } from "./gestures";
import { InputBindingProfile } from "./input-bindings";
import type {
  ActionBinding,
  ActionMapping,
  AxisBinding,
  AxisMapping,
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
  inputs: Record<string, InputValueState>;
  /** Physical rising edges in delivery order; analog controls cross 0.5. */
  pressedKeys: InputKey[];
  actions: Record<string, ActionState>;
  axes: Record<string, number>;
  axes2D: Record<string, Axis2DValue>;
  gamepadConnections: GamepadConnectionEvent[];
  /** Primary pointer / mouse in canvas CSS pixels. XY sticks after release. */
  cursor: { x: number; y: number; pressed: boolean };
  /** Every contact down during this tick in Finger order, including those lifted this tick. */
  touches: TouchInput[];
  /** Began, Moved (one per contact per tick) and Ended or Cancelled records in input order. */
  touchEvents: TouchInput[];
}

/** A pointer holding its primary button: a finger, a pen tip or the left mouse button. */
interface Contact {
  /** Live state; copied whenever it leaves the resolver. */
  touch: TouchInput;
  /** Position at the start of this tick, or at the press. */
  baseX: number;
  baseY: number;
  /** This tick's Moved record, updated in place by later moves in the tick. */
  moved: TouchInput | null;
}

interface ModifierState {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

interface ResolverInternals {
  heldKeys: Set<string>;
  heldPointerButtons: Set<number>;
  pointerButtons: Map<number, Set<number>>;
  heldGamepadButtons: Set<string>;
  gamepadAxes: Map<string, number>;
  touchAxes: Map<string, number>;
  connectedPads: Set<number>;
  modifiers: ModifierState;
  previousHeldActions: Set<string>;
  cursor: { x: number; y: number; pressed: boolean };
  primaryPointerId: number | null;
  /** Live contacts by pointer id. */
  contacts: Map<number, Contact>;
  /** Contacts lifted this tick; their fingers stay taken until the next tick. */
  liftedContacts: Contact[];
  /** This tick's gesture values by `touch` binding code. */
  gestureValues: Map<string, number>;
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
      return state.heldPointerButtons.has(Number(binding.code));
    case "gamepadButton":
      return state.heldGamepadButtons.has(binding.code);
    case "touch":
      return touchControlValue(state, binding.code) > 0.5;
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
      const raw = touchControlValue(state, binding.code);
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

const TOUCH_TYPE: Record<PointerKind, TouchType> = { mouse: "Mouse", touch: "Finger", pen: "Pen" };

/** A `touch` binding code: an on-screen control's axis, or a gesture. */
function touchControlValue(state: ResolverInternals, code: string): number {
  // A released joystick axis stores 0; it must not hide a gesture with the same code.
  return (state.touchAxes.get(code) ?? 0) || (state.gestureValues.get(code) ?? 0);
}

function copyTouch(touch: TouchInput): TouchInput {
  return {
    ...touch,
    Position: { ...touch.Position },
    Delta: { ...touch.Delta },
    Velocity: { ...touch.Velocity },
    StartPosition: { ...touch.StartPosition },
  };
}

/** Browsers report 0.5 while pressed on hardware without pressure; a missing value reads the same. */
function contactPressure(pressure: number | undefined, fallback: number): number {
  return typeof pressure === "number" && Number.isFinite(pressure)
    ? Math.min(1, Math.max(0, pressure))
    : fallback;
}

function sameMembers(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function updateModifiers(state: ResolverInternals): void {
  const held = state.heldKeys;
  state.modifiers.shift = held.has("ShiftLeft") || held.has("ShiftRight");
  state.modifiers.ctrl = held.has("ControlLeft") || held.has("ControlRight");
  state.modifiers.alt = held.has("AltLeft") || held.has("AltRight");
  state.modifiers.meta = held.has("MetaLeft") || held.has("MetaRight");
}

/**
 * Stateful fold of raw tick-stamped events into per-tick action / axis values.
 * Pure with respect to the browser: feed it synthetic streams from the
 * deterministic harness (engineplan §11.1).
 */
export class InputResolver {
  private readonly state: ResolverInternals = {
    heldKeys: new Set(),
    heldPointerButtons: new Set(),
    pointerButtons: new Map(),
    heldGamepadButtons: new Set(),
    gamepadAxes: new Map(),
    touchAxes: new Map(),
    connectedPads: new Set(),
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    previousHeldActions: new Set(),
    cursor: { x: 0, y: 0, pressed: false },
    primaryPointerId: null,
    contacts: new Map(),
    liftedContacts: [],
    gestureValues: new Map(),
  };

  private readonly gestures = new GestureRecognizer();
  /** The tick being resolved, for touch velocities. */
  private tickSeconds = 0;
  private mappings: InputMappings;
  private inputStates: Record<string, InputValueState> = {};
  readonly bindings: InputBindingProfile;

  constructor(mappings: InputMappings) {
    this.mappings = structuredClone(mappings);
    this.bindings = new InputBindingProfile(mappings, (current) => {
      this.mappings = current;
    });
  }

  /** Clear physical/derived input without advancing time or changing binding overrides. */
  reset(): ResolvedInputTick {
    this.state.heldKeys.clear();
    this.state.heldPointerButtons.clear();
    this.state.pointerButtons.clear();
    this.state.heldGamepadButtons.clear();
    this.state.gamepadAxes.clear();
    this.state.touchAxes.clear();
    this.state.connectedPads.clear();
    this.state.previousHeldActions.clear();
    this.state.modifiers = { shift: false, ctrl: false, alt: false, meta: false };
    this.state.cursor.pressed = false;
    this.state.primaryPointerId = null;
    this.state.contacts.clear();
    this.state.liftedContacts.length = 0;
    this.state.gestureValues.clear();
    this.gestures.reset();
    this.inputStates = {};
    return this.resolve([]);
  }

  /** The game view's CSS size, which two-finger drags are measured against. */
  setViewSize(width: number, height: number): void {
    this.gestures.setViewSize(width, height);
  }

  /**
   * Apply one tick's events and return the resolved action / axis snapshot.
   * `deltaSeconds` is game time (Held Seconds); `inputSeconds`, real time for
   * human gestures and touch velocity, so time dilation does not change them.
   */
  resolve(
    events: readonly RawInputEvent[],
    deltaSeconds = 0,
    inputSeconds = deltaSeconds,
  ): ResolvedInputTick {
    const inputs: Record<string, InputValueState> = {};
    const pressedKeys: InputKey[] = [];
    const pressed = (
      device: Parameters<typeof inputKeyFromControl>[0],
      code: string,
    ) => {
      const key = inputKeyFromControl(device, code);
      if (key) pressedKeys.push(key);
    };
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    const recordInput = (
      mapping: ActionMapping | AxisMapping,
      valueType: InputValueState["valueType"],
      value: InputValueState["value"],
    ) => {
      const key = inputMappingKey(mapping);
      const held =
        typeof value === "object" ? value.x !== 0 || value.y !== 0 : !!value;
      const previous = inputs[key] ?? this.inputStates[key];
      const accumulated = inputs[key];
      inputs[key] = {
        input: { Name: mapping.name, Asset: mapping.id ?? "" },
        valueType,
        value,
        ...(valueType !== "button" && held && typeof value !== "boolean" ? { activeValue: value }
          : accumulated?.activeValue !== undefined ? { activeValue: accumulated.activeValue } : {}),
        held,
        started: !!accumulated?.started || (held && !previous?.held),
        released: !!accumulated?.released || (!held && !!previous?.held),
        heldSeconds: held ? (previous?.held ? previous.heldSeconds : 0) : 0,
        lastHeldSeconds:
          !held && previous?.held
            ? previous.heldSeconds
            : (previous?.lastHeldSeconds ?? 0),
      };
    };
    const connections: GamepadConnectionEvent[] = [];
    const touchEvents: TouchInput[] = [];
    const dt = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const inputDt = Number.isFinite(inputSeconds) ? Math.max(0, inputSeconds) : 0;
    this.tickSeconds = inputDt;
    this.beginTouchTick();
    // Name lookups (`isActionHeld("Jump")`) cover every asset with that display
    // name; `inputs` keeps each asset's own state.
    const actions: Record<string, ActionState> = {};
    const heldNow = new Set(this.state.previousHeldActions);
    const heldByName = new Map<string, boolean>();
    // Each axis mapping's clamped value at the latest sample; `axes` reuses it.
    const axisValues = this.mappings.axes.map(() => ({ x: 0, y: 0 }));
    // One pass reads every binding once and updates both per-asset `inputs` and
    // name-keyed `actions`.
    const sample = () => {
      heldByName.clear();
      for (const mapping of this.mappings.actions) {
        const held = mapping.bindings.some((binding) =>
          actionBindingHeld(binding, this.state),
        );
        heldByName.set(mapping.name, heldByName.get(mapping.name) === true || held);
        recordInput(mapping, "button", held);
      }
      for (const [name, held] of heldByName) {
        const wasHeld = heldNow.has(name);
        const prior = actions[name];
        actions[name] = {
          held,
          pressed: (prior?.pressed ?? false) || (held && !wasHeld),
          released: (prior?.released ?? false) || (!held && wasHeld),
        };
        if (held) heldNow.add(name);
        else heldNow.delete(name);
      }
      this.mappings.axes.forEach((mapping, index) => {
        const twoD = mapping.kind === "2d";
        let x = 0;
        let y = 0;
        for (const binding of mapping.bindings) {
          const amount = axisBindingValue(binding, this.state);
          if (twoD && binding.component === "y") y += amount;
          else x += amount;
        }
        const value = axisValues[index]!;
        value.x = clamp(x);
        value.y = clamp(y);
        recordInput(mapping, twoD ? "2d" : "1d", twoD ? { x: value.x, y: value.y } : value.x);
      });
    };

    // Pulse gestures last one tick. Releasing them before the first sample
    // lets a pulse on the very next tick start the input again.
    for (const code of TOUCH_PULSE_GESTURES) this.state.gestureValues.delete(code);
    // A mapping change can release an action before the first new event arrives.
    // Observe that boundary so a fresh press of the replacement key keeps its edge.
    sample();
    // Each event samples on its own so a press and release in one tick both
    // edge. An event that left every control `sample` reads unchanged (pointer
    // move, key repeat, steady stick) is skipped: a repeat sample rewrites the
    // same results unless mappings share an `inputs` key.
    let dirty = false;
    let keysShared: boolean | undefined;
    for (const event of events) {
      switch (event.kind) {
        case "key": {
          const down = event.phase === "down";
          const wasHeld = this.state.heldKeys.has(event.code);
          if (down && !wasHeld) pressed("key", event.code);
          if (down) this.state.heldKeys.add(event.code);
          else this.state.heldKeys.delete(event.code);
          if (down !== wasHeld) dirty = true;
          updateModifiers(this.state);
          break;
        }
        case "pointer": {
          const contacts = this.state.pointerButtons;
          // Only the first contact controls the cursor. Existing secondary
          // fingers stay secondary until lifted, even after the first lifts;
          // a new contact becomes primary whenever no primary contact is down.
          const primary = this.state.primaryPointerId;
          const primaryDown = primary !== null && contacts.has(primary);
          if (
            (contacts.size === 0 &&
              (event.phase === "down" || event.phase === "move")) ||
            (event.phase === "down" &&
              !primaryDown &&
              !contacts.has(event.pointerId))
          ) {
            this.state.primaryPointerId = event.pointerId;
          }
          if (event.phase === "down") {
            const buttons = contacts.get(event.pointerId) ?? new Set<number>();
            buttons.add(event.button);
            contacts.set(event.pointerId, buttons);
          } else if (event.phase === "cancel") {
            contacts.delete(event.pointerId);
          } else if (event.phase === "up") {
            const buttons = contacts.get(event.pointerId);
            // pointerup only fires once no buttons remain. An up for a button
            // this contact never pressed means a chord edge was missed.
            if (!buttons?.delete(event.button)) buttons?.clear();
            if (!buttons?.size) contacts.delete(event.pointerId);
          }
          if (event.pointerId === this.state.primaryPointerId) {
            this.state.cursor.x = event.x;
            this.state.cursor.y = event.y;
            if (
              event.phase === "down" &&
              !this.state.heldPointerButtons.has(event.button)
            )
              pressed("mouseButton", String(event.button));
            const heldButtons = new Set(contacts.get(event.pointerId));
            if (!sameMembers(this.state.heldPointerButtons, heldButtons))
              dirty = true;
            this.state.heldPointerButtons = heldButtons;
            this.state.cursor.pressed = this.state.heldPointerButtons.has(0);
            if (
              (event.phase === "up" || event.phase === "cancel") &&
              !contacts.has(event.pointerId)
            ) {
              this.state.primaryPointerId = null;
            }
          }
          this.trackContact(event, touchEvents);
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
              if (!this.state.heldGamepadButtons.has(key)) {
                pressed("gamepadButton", key);
                dirty = true;
              }
              this.state.heldGamepadButtons.add(key);
            } else if (this.state.heldGamepadButtons.delete(key)) {
              dirty = true;
            }
          }
          for (let i = 0; i < event.axes.length; i++) {
            const key = `${pad}:${i}`;
            const value = event.axes[i] ?? 0;
            const previous = this.state.gamepadAxes.get(key);
            if (Math.abs(value) > 0.5 && Math.abs(previous ?? 0) <= 0.5)
              pressed("gamepadAxis", key);
            if (!Object.is(previous, value)) dirty = true;
            this.state.gamepadAxes.set(key, value);
          }
          // A sample is the pad's whole state: controls it omits are at rest.
          const prefix = `${pad}:`;
          const sampled = (key: string, count: number) =>
            !key.startsWith(prefix) || Number(key.slice(prefix.length)) < count;
          for (const key of [...this.state.heldGamepadButtons]) {
            if (!sampled(key, event.buttons.length)) {
              this.state.heldGamepadButtons.delete(key);
              dirty = true;
            }
          }
          for (const key of [...this.state.gamepadAxes.keys()]) {
            if (!sampled(key, event.axes.length)) {
              this.state.gamepadAxes.delete(key);
              dirty = true;
            }
          }
          break;
        }
        case "gamepadDisconnect": {
          const pad = event.gamepadIndex;
          if (!this.state.connectedPads.delete(pad)) break;
          connections.push({ gamepadIndex: pad, connected: false });
          // The pad's last sample must not keep actions held or sticks deflected.
          for (const key of [...this.state.heldGamepadButtons]) {
            if (key.startsWith(`${pad}:`)) {
              this.state.heldGamepadButtons.delete(key);
              dirty = true;
            }
          }
          for (const key of [...this.state.gamepadAxes.keys()]) {
            if (key.startsWith(`${pad}:`)) {
              this.state.gamepadAxes.delete(key);
              dirty = true;
            }
          }
          break;
        }
        case "touchAxis": {
          if (!Object.is(this.state.touchAxes.get(event.controlId), event.value))
            dirty = true;
          this.state.touchAxes.set(event.controlId, event.value);
          break;
        }
        default:
          break;
      }
      if (dirty || (keysShared ??= this.mappingKeysShared())) {
        sample();
        dirty = false;
      }
    }

    this.settleTouchVelocities();
    const touches = [...this.state.contacts.values(), ...this.state.liftedContacts]
      .map((contact) => copyTouch(contact.touch))
      .sort((a, b) => a.Finger - b.Finger);
    this.state.gestureValues = this.gestures.step(touchEvents, touches, inputDt);
    sample();
    this.state.previousHeldActions = new Set(
      this.mappings.actions
        .filter((mapping) => heldNow.has(mapping.name))
        .map((mapping) => mapping.name),
    );

    // Assets sharing a display name add up like the bindings of one asset.
    const sums1D = new Map<string, number>();
    const sums2D = new Map<string, Axis2DValue>();
    this.mappings.axes.forEach((mapping, index) => {
      const value = axisValues[index]!;
      if (mapping.kind === "2d") {
        const sum = sums2D.get(mapping.name) ?? { x: 0, y: 0 };
        sums2D.set(mapping.name, { x: sum.x + value.x, y: sum.y + value.y });
      } else {
        sums1D.set(mapping.name, (sums1D.get(mapping.name) ?? 0) + value.x);
      }
    });
    const axes: Record<string, number> = {};
    const axes2D: Record<string, Axis2DValue> = {};
    for (const [name, sum] of sums2D) {
      axes2D[name] = { x: clamp(sum.x), y: clamp(sum.y) };
      // A 2D axis is also readable as its magnitude for getAxis callers.
      axes[name] = Math.hypot(axes2D[name]!.x, axes2D[name]!.y);
    }
    for (const [name, sum] of sums1D) axes[name] = clamp(sum);

    for (const [key, value] of Object.entries(inputs)) {
      if (value.held && !value.started && this.inputStates[key]?.held)
        value.heldSeconds += dt;
    }
    this.inputStates = inputs;
    return {
      inputs,
      pressedKeys,
      actions,
      axes,
      axes2D,
      gamepadConnections: connections,
      cursor: { ...this.state.cursor },
      touches,
      touchEvents,
    };
  }

  /** Free last tick's lifted fingers; live contacts start the tick unmoved. */
  private beginTouchTick(): void {
    this.state.liftedContacts.length = 0;
    for (const contact of this.state.contacts.values()) {
      const touch = contact.touch;
      contact.baseX = touch.Position.x;
      contact.baseY = touch.Position.y;
      contact.moved = null;
      touch.Delta = { x: 0, y: 0 };
      touch.Phase = "Stationary";
    }
  }

  /** Halfway between the last velocity and this tick's movement, so one uneven tick does not dominate. */
  private settleVelocity(contact: Contact): void {
    if (this.tickSeconds <= 0) return;
    const touch = contact.touch;
    touch.Velocity = {
      x: (touch.Velocity.x + touch.Delta.x / this.tickSeconds) / 2,
      y: (touch.Velocity.y + touch.Delta.y / this.tickSeconds) / 2,
    };
  }

  /** Live contacts take this tick's velocity; lifted ones took it as they lifted. */
  private settleTouchVelocities(): void {
    for (const contact of this.state.contacts.values()) {
      this.settleVelocity(contact);
      if (contact.moved) contact.moved.Velocity = { ...contact.touch.Velocity };
    }
  }

  private freeFinger(): number {
    const taken = new Set<number>();
    for (const contact of this.state.contacts.values()) taken.add(contact.touch.Finger);
    for (const contact of this.state.liftedContacts) taken.add(contact.touch.Finger);
    let finger = 0;
    while (taken.has(finger)) finger++;
    return finger;
  }

  /**
   * A contact begins when its pointer starts holding button 0 and ends when
   * it stops, after `pointerButtons` has taken the event into account.
   */
  private trackContact(
    event: Extract<RawInputEvent, { kind: "pointer" }>,
    touchEvents: TouchInput[],
  ): void {
    const holdsPrimary = this.state.pointerButtons.get(event.pointerId)?.has(0) === true;
    const contact = this.state.contacts.get(event.pointerId);
    if (!contact) {
      if (event.phase !== "down" || !holdsPrimary) return;
      const touch: TouchInput = {
        Finger: this.freeFinger(),
        Position: { x: event.x, y: event.y },
        Delta: { x: 0, y: 0 },
        Velocity: { x: 0, y: 0 },
        StartPosition: { x: event.x, y: event.y },
        Pressure: contactPressure(event.pressure, 0.5),
        Phase: "Began",
        Type: TOUCH_TYPE[event.pointerType ?? "mouse"],
      };
      this.state.contacts.set(event.pointerId, { touch, baseX: event.x, baseY: event.y, moved: null });
      touchEvents.push(copyTouch(touch));
      return;
    }
    const touch = contact.touch;
    // A cancel may carry no real position; an up reports where the contact lifted.
    if (event.phase !== "cancel") {
      touch.Position = { x: event.x, y: event.y };
      touch.Delta = { x: event.x - contact.baseX, y: event.y - contact.baseY };
    }
    // Pressure drops to 0 once nothing is pressed, so a lift keeps the last sample.
    if (event.phase === "down" || event.phase === "move") {
      touch.Pressure = contactPressure(event.pressure, touch.Pressure);
    }
    if (!holdsPrimary) {
      this.settleVelocity(contact);
      if (contact.moved) contact.moved.Velocity = { ...touch.Velocity };
      touch.Phase = event.phase === "cancel" ? "Cancelled" : "Ended";
      this.state.contacts.delete(event.pointerId);
      this.state.liftedContacts.push(contact);
      touchEvents.push(copyTouch(touch));
      return;
    }
    if (contact.moved) {
      // The tick's one Moved record ends where the contact ends the tick.
      contact.moved.Position = { ...touch.Position };
      contact.moved.Delta = { ...touch.Delta };
      contact.moved.Pressure = touch.Pressure;
      return;
    }
    if (touch.Delta.x === 0 && touch.Delta.y === 0) return;
    if (touch.Phase !== "Began") touch.Phase = "Moved";
    contact.moved = { ...copyTouch(touch), Phase: "Moved" };
    touchEvents.push(contact.moved);
  }

  /**
   * Mappings with one `inputs` key accumulate it once per sample, so sampling
   * unchanged state again is a no-op. Mappings sharing a key fold into each
   * other's entry within one sample, so a repeat sample would change it.
   */
  private mappingKeysShared(): boolean {
    const rows = [...this.mappings.actions, ...this.mappings.axes];
    return new Set(rows.map((row) => inputMappingKey(row))).size !== rows.length;
  }

  getInputState(input: InputTypeValue): InputValueState | null {
    const action = this.mappings.actions.find((entry) => entry.id === input?.Asset);
    const axis = action ? undefined : this.mappings.axes.find((entry) => entry.id === input?.Asset);
    const mapping = action ?? axis;
    if (!mapping) return null;
    const valueType = axis ? (axis.kind === "2d" ? "2d" : "1d") : "button";
    return (
      this.inputStates[mapping.id!] ?? {
        input: { Name: mapping.name, Asset: mapping.id! },
        valueType,
        started: false,
        held: false,
        released: false,
        value:
          valueType === "button"
            ? false
            : valueType === "2d"
              ? { x: 0, y: 0 }
              : 0,
        heldSeconds: 0,
        lastHeldSeconds: 0,
      }
    );
  }
}

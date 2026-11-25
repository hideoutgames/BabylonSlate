import {
  countText2DRevealCharacters, text2DCharacterReveal, text2DCustomAppearModeClassId,
  text2DFormattedUnits, TEXT2D_LETTER_POSE_STRIDE, type Text2DProperties,
} from "@haptic/core";
import {
  EngineObject, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID, RICH_TEXT_2D_LETTER_EFFECT_CLASS_ID,
  RICH_TEXT_2D_LETTER_CLASS_ID, RICH_TEXT_UPDATE_LETTERS_EVENT, RICH_TEXT_GET_KEYS_FUNCTION, RICH_TEXT_LETTER_APPEAR_EVENT,
  type ActorComponent, type World,
} from "@haptic/object-model";
import { jsIdent } from "@haptic/scripting";

/** What letter scripting needs from the session: its World's classes and the script host's dispatch. */
export interface Text2DLetterScriptsHost {
  world(): Pick<World, "classRegistry" | "createObject">;
  invokeEvent(classId: string, event: string, self: EngineObject, args: Record<string, unknown>): void;
  /**
   * Runs script function `name` (its export name) on `self` and returns its outputs by output pin name; null when
   * `self` has no such function or it waits (a latent function), which counts as no result.
   */
  callFunction(self: EngineObject, name: string): Record<string, unknown> | null;
}

type ScriptedClass = { classId: string; self: EngineObject };
/** One `onUpdateLetters` call: letters under tags of one Class with one Strength and one value per declared key. */
type EffectCall = ScriptedClass & { strength: number; letters: PackedLetterObject[]; values: ReadonlyMap<string, string> };
type LetterState = {
  /** The component's variables revision this state was read at. */
  revision: number;
  /** Text and scripted Classes the letters and instances were built for. */
  signature: string;
  properties: Text2DProperties;
  count: number;
  letters: PackedLetterObject[];
  modes: ScriptedClass[];
  effectCalls: EffectCall[];
  instances: Map<string, EngineObject>;
  /** Rest poses for `letters.length` characters, copied in one `set()` on each appear pass. */
  rest: Float32Array;
  /** Live working pose buffer backed directly by `PackedLetterObject` getters/setters. */
  working: Float32Array;
  /** Poses the Appear Modes left, which Letter Effects start from each tick. */
  appear: Float32Array;
  /** The reveal position `appear` was computed at; NaN when it must be computed again. */
  appearProgress: number;
  /** The poses the renderer holds; empty while every letter is at rest. */
  sent: Float32Array;
};

const REST = [0, 0, 1, 1, 0, 1, 1, 1, 1] as const;
const NO_POSES = new Float32Array(0);
const NO_VALUES: ReadonlyMap<string, string> = new Map();
/** A letter's Tint at rest, shared: script colour values are never changed in place. */
const WHITE = Object.freeze({ x: 1, y: 1, z: 1, w: 1 });
const GET_KEYS = jsIdent(RICH_TEXT_GET_KEYS_FUNCTION.name);
const KEYS_OUTPUT = RICH_TEXT_GET_KEYS_FUNCTION.pins.find((pin) => pin.direction === "out" && pin.typeId !== "exec")!.name;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/** A script colour (`{ x, y, z }`, `{ r, g, b }` or `[r, g, b]`) channel, clamped to 0..1; alpha is not read. */
function tintChannel(tint: unknown, index: 0 | 1 | 2): number {
  if (Array.isArray(tint)) return clampUnit(finite(tint[index], 1));
  if (!tint || typeof tint !== "object") return 1;
  const color = tint as Record<string, unknown>;
  return clampUnit(finite(color[index === 0 ? "x" : index === 1 ? "y" : "z"] ?? color[index === 0 ? "r" : index === 1 ? "g" : "b"], 1));
}

/**
 * RichText2DLetter backed directly on the component's flat `Float32Array` pose
 * buffer (`offsetX, offsetY, scaleX, scaleY, rotation, opacity, tintR, tintG, tintB`).
 * Avoids per-letter `Map.get/set` and `{ x, y }` wrapper allocations on every tick.
 */
class PackedLetterObject extends EngineObject {
  readonly letterIndex: number;
  private readonly character: string;
  private readonly buf: Float32Array;
  private readonly base: number;

  constructor(guid: string, index: number, character: string, buf: Float32Array, base: number) {
    super({ classId: RICH_TEXT_2D_LETTER_CLASS_ID, guid });
    this.letterIndex = index;
    this.character = character;
    this.buf = buf;
    this.base = base;
  }

  override getVariable(name: string): unknown {
    const b = this.base;
    const buf = this.buf;
    switch (name) {
      case "index": return this.letterIndex;
      case "character": return this.character;
      case "offset": return { x: buf[b]!, y: buf[b + 1]! };
      case "scale": return { x: buf[b + 2]!, y: buf[b + 3]! };
      case "rotation": return buf[b + 4]!;
      case "opacity": return buf[b + 5]!;
      case "tint": {
        const r = buf[b + 6]!, g = buf[b + 7]!, bl = buf[b + 8]!;
        return r === 1 && g === 1 && bl === 1 ? WHITE : { x: r, y: g, z: bl, w: 1 };
      }
      default: return super.getVariable(name);
    }
  }

  override setVariable(name: string, value: unknown): void {
    const b = this.base;
    const buf = this.buf;
    switch (name) {
      case "offset": {
        const v = value as { x?: unknown; y?: unknown } | null | undefined;
        buf[b] = finite(v?.x, 0);
        buf[b + 1] = finite(v?.y, 0);
        return;
      }
      case "scale": {
        const v = value as { x?: unknown; y?: unknown } | null | undefined;
        buf[b + 2] = finite(v?.x, 1);
        buf[b + 3] = finite(v?.y, 1);
        return;
      }
      case "rotation":
        buf[b + 4] = finite(value, 0);
        return;
      case "opacity":
        buf[b + 5] = clampUnit(finite(value, 1));
        return;
      case "tint":
        if (value === WHITE) {
          buf[b + 6] = 1;
          buf[b + 7] = 1;
          buf[b + 8] = 1;
        } else {
          buf[b + 6] = tintChannel(value, 0);
          buf[b + 7] = tintChannel(value, 1);
          buf[b + 8] = tintChannel(value, 2);
        }
        return;
      default:
        super.setVariable(name, value);
    }
  }
}

function buildRestBuffer(letterCount: number): Float32Array {
  const rest = new Float32Array(letterCount * TEXT2D_LETTER_POSE_STRIDE);
  for (let i = 0; i < letterCount; i++) {
    rest.set(REST, i * TEXT2D_LETTER_POSE_STRIDE);
  }
  return rest;
}

/** The tag keywords a Letter Effect declares with Get Keys: lower-cased, distinct, non-empty strings. */
function declaredKeys(outputs: Record<string, unknown> | null): readonly string[] {
  const keys = outputs?.[KEYS_OUTPUT];
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.flatMap((key) => typeof key === "string" && key.trim() ? [key.trim().toLowerCase()] : []))];
}

function atRest(poses: Float32Array): boolean {
  for (let i = 0; i < poses.length; i += TEXT2D_LETTER_POSE_STRIDE) {
    if (
      poses[i] !== 0 || poses[i + 1] !== 0 ||
      poses[i + 2] !== 1 || poses[i + 3] !== 1 ||
      poses[i + 4] !== 0 || poses[i + 5] !== 1 ||
      poses[i + 6] !== 1 || poses[i + 7] !== 1 || poses[i + 8] !== 1
    ) {
      return false;
    }
  }
  return true;
}

function samePoses(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Runs Rich Text 2D Appear Mode and Letter Effect Classes on a 2D Rich Text's letters. Scripts pose engine-made
 * Letter objects; the packed poses (`TEXT2D_LETTER_POSE_STRIDE` numbers per reveal character) are what the renderer
 * receives. Appear Modes run when the reveal moves, Letter Effects every tick on top of what they left.
 */
export class Text2DLetterScripts {
  private host: Text2DLetterScriptsHost | null = null;
  /** A 2D Rich Text's properties as drawn, its custom tags expanded (`Text2DAppearRuntime.properties`). */
  private readonly properties: (component: ActorComponent) => Text2DProperties;
  private readonly states = new Map<ActorComponent, LetterState>();
  private readonly dirty = new Set<ActorComponent>();
  /** The variables revision at which a component was last found to script nothing. */
  private readonly idle = new WeakMap<ActorComponent, number>();
  /**
   * The script whose tag Get Tag Value reads now, and that tag's values by lower-cased key: a Letter Effect in its
   * `onUpdateLetters` (its declared keys), or a Rich Text Decorator in its Decorate (every keyword of its tag).
   */
  private tagSelf: EngineObject | null = null;
  private tagValues: ReadonlyMap<string, string> = NO_VALUES;

  constructor(properties: (component: ActorComponent) => Text2DProperties) {
    this.properties = properties;
  }

  bind(host: Text2DLetterScriptsHost): void {
    this.host = host;
  }

  /** True when `component` was checked at `revision` and has no custom Appear Mode or Letter Effect scripts. */
  isIdleAt(component: ActorComponent, revision: number): boolean {
    return !this.states.has(component) && this.idle.get(component) === revision;
  }

  /** The poses the renderer holds for `component`, for an assignment that rebuilds its visual; undefined at rest. */
  poses(component: ActorComponent): Float32Array | undefined {
    const sent = this.states.get(component)?.sent;
    return sent?.length ? sent : undefined;
  }

  advance(component: ActorComponent, progress: number, deltaSeconds: number): void {
    const state = this.stateOf(component);
    if (!state) return;
    const host = this.host!;
    const moved = state.appearProgress !== progress;
    if (moved) {
      state.working.set(state.rest);
      for (const mode of state.modes) {
        for (const letter of state.letters) {
          const alpha = text2DCharacterReveal(progress, letter.letterIndex, state.count, state.properties);
          host.invokeEvent(mode.classId, RICH_TEXT_LETTER_APPEAR_EVENT.exportName, mode.self, { letter, alpha });
        }
      }
      state.appear.set(state.working);
      state.appearProgress = progress;
    }
    if (state.effectCalls.length > 0) {
      if (!moved) state.working.set(state.appear);
      for (const call of state.effectCalls) {
        // Get Tag Value reads the values of this call's tag.
        this.withTag(call.self, call.values, () => host.invokeEvent(call.classId, RICH_TEXT_UPDATE_LETTERS_EVENT.exportName, call.self, {
          letters: [...call.letters], deltaSeconds, strength: call.strength,
        }));
      }
    } else if (!moved) return;
    this.send(component, state, atRest(state.working) ? NO_POSES : state.working);
  }

  /** Get Tag Value: the value of `key` (any case) in the tag `self` runs for now; "" outside such a call. */
  tagValue(self: EngineObject | null, key: string): string {
    return self !== null && self === this.tagSelf ? this.tagValues.get(key.toLowerCase()) ?? "" : "";
  }

  /** Runs `run` with Get Tag Value on `self` reading `values`, then restores the tag that was current before. */
  withTag<T>(self: EngineObject, values: ReadonlyMap<string, string>, run: () => T): T {
    const previousSelf = this.tagSelf, previousValues = this.tagValues;
    this.tagSelf = self;
    this.tagValues = values;
    try {
      return run();
    } finally {
      this.tagSelf = previousSelf;
      this.tagValues = previousValues;
    }
  }

  /** The text `component` draws changed without a variable write: its letters are read again on its next advance. */
  invalidate(component: ActorComponent): void {
    const state = this.states.get(component);
    if (state) state.revision = Number.NaN;
    this.idle.delete(component);
  }

  flush(send: (component: ActorComponent, poses: Float32Array) => void): void {
    for (const component of this.dirty) {
      if (!component.destroyed && component.owner && !component.owner.destroyed) {
        const sent = this.states.get(component)?.sent ?? NO_POSES;
        // Fresh Float32Array slice so worker-entry can transfer ownership without detaching `state.sent`.
        send(component, sent.length > 0 ? sent.slice() : new Float32Array(0));
      }
    }
    this.dirty.clear();
  }

  remove(component: ActorComponent): void {
    const state = this.states.get(component);
    if (state) this.release(state);
    this.states.delete(component);
    this.dirty.delete(component);
  }

  private send(component: ActorComponent, state: LetterState, poses: Float32Array): void {
    if (samePoses(state.sent, poses)) return;
    if (poses.length === 0) {
      state.sent = NO_POSES;
    } else {
      if (state.sent.length !== poses.length) state.sent = new Float32Array(poses.length);
      state.sent.set(poses);
    }
    this.dirty.add(component);
  }

  private release(state: LetterState): void {
    for (const object of [...state.letters, ...state.instances.values()]) object.destroyed = true;
  }

  /** The component's scripting state, rebuilt when its text or scripted Classes change; null when it scripts nothing. */
  private stateOf(component: ActorComponent): LetterState | null {
    if (!this.host) return null;
    const previous = this.states.get(component);
    const revision = component.variablesRevision;
    if (previous && previous.revision === revision) return previous;
    if (!previous && this.idle.get(component) === revision) return null;
    const properties = this.properties(component);
    const units = text2DFormattedUnits(properties.text, undefined, { rich: true }).filter((unit) => unit.kind !== "lineBreak");
    const modeIds = properties.appearModes.flatMap((mode) => text2DCustomAppearModeClassId(mode) ?? []);
    const effectIds = [...new Set(units.flatMap((unit) => unit.effects.custom?.map((effect) => effect.name) ?? []))];
    if (modeIds.length === 0 && effectIds.length === 0) {
      this.idle.set(component, revision);
      if (previous) {
        // The renderer returns every letter to rest once nothing scripts them.
        this.release(previous);
        this.states.delete(component);
        if (previous.sent.length) this.dirty.add(component);
      }
      return null;
    }
    const signature = JSON.stringify([properties.text, modeIds]);
    const state: LetterState = previous?.signature === signature
      ? { ...previous, revision, properties, appearProgress: Number.NaN }
      : this.build(component, previous, signature, properties, units, modeIds);
    state.revision = revision;
    this.states.set(component, state);
    return state;
  }

  private build(
    component: ActorComponent,
    previous: LetterState | undefined,
    signature: string,
    properties: Text2DProperties,
    units: ReturnType<typeof text2DFormattedUnits>,
    modeIds: readonly string[],
  ): LetterState {
    if (previous) for (const letter of previous.letters) letter.destroyed = true;
    const instances = previous?.instances ?? new Map<string, EngineObject>();
    const instance = (classId: string, base: string): EngineObject | null => {
      const { classRegistry } = this.host!.world();
      if (classId === base || !classRegistry.has(classId) || !classRegistry.isA(classId, base)) return null;
      let self = instances.get(classId);
      if (!self) instances.set(classId, self = this.host!.world().createObject({ classId }));
      return self;
    };
    const rest = buildRestBuffer(units.length);
    const working = new Float32Array(rest);
    const appear = new Float32Array(rest);
    const letters: PackedLetterObject[] = [];
    const effectCalls = new Map<string, EffectCall>();
    // Each Letter Effect's Get Keys, called once per build.
    const declared = new Map<string, readonly string[]>();
    const keysOf = (classId: string, self: EngineObject): readonly string[] => {
      let keys = declared.get(classId);
      if (!keys) declared.set(classId, keys = declaredKeys(this.host!.callFunction(self, GET_KEYS)));
      return keys;
    };
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]!;
      if (unit.kind === "lineBreak") continue;
      const letter = new PackedLetterObject(
        `${component.guid}:letter:${unit.index}`,
        unit.index,
        unit.kind === "glyph" ? unit.ch : "",
        working,
        i * TEXT2D_LETTER_POSE_STRIDE,
      );
      letters.push(letter);
      for (const effect of unit.effects.custom ?? []) {
        const self = instance(effect.name, RICH_TEXT_2D_LETTER_EFFECT_CLASS_ID);
        if (!self) continue;
        // Letters under one Strength and the same values of the Class's declared keys are updated together, in
        // text order; keywords the Class does not declare do not split them.
        const keys = keysOf(effect.name, self);
        let group = `${effect.name}\0${effect.strength}`;
        for (const key of keys) group += `\0${Object.hasOwn(effect.attrs, key) ? effect.attrs[key] : ""}`;
        let call = effectCalls.get(group);
        if (!call) {
          const values = new Map<string, string>();
          for (const key of keys) if (Object.hasOwn(effect.attrs, key)) values.set(key, effect.attrs[key]!);
          effectCalls.set(group, call = { classId: effect.name, self, strength: effect.strength, letters: [], values });
        }
        call.letters.push(letter);
      }
    }
    const modes = modeIds.flatMap((classId): ScriptedClass[] => {
      const self = instance(classId, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID);
      return self ? [{ classId, self }] : [];
    });
    return {
      revision: 0, signature, properties, count: countText2DRevealCharacters(properties), letters, modes,
      effectCalls: [...effectCalls.values()], instances, rest, working, appear, appearProgress: Number.NaN,
      sent: previous?.sent ?? NO_POSES,
    };
  }
}

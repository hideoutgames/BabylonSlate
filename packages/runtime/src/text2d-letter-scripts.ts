import {
  countText2DRevealCharacters, parseText2DProperties, text2DCharacterReveal, text2DCustomAppearModeClassId,
  text2DFormattedUnits, TEXT2D_LETTER_POSE_STRIDE, type Text2DProperties,
} from "@haptic/core";
import {
  EngineObject, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID, RICH_TEXT_2D_DECORATOR_EFFECT_CLASS_ID,
  RICH_TEXT_2D_LETTER_CLASS_ID, RICH_TEXT_DECORATE_LETTERS_EVENT, RICH_TEXT_GET_KEYS_FUNCTION, RICH_TEXT_LETTER_APPEAR_EVENT,
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
/** One `onDecorateLetters` call: letters under tags of one Class with one Strength and one value per declared key. */
type Decorator = ScriptedClass & { strength: number; letters: EngineObject[]; values: ReadonlyMap<string, string> };
type LetterState = {
  /** The component's variables revision this state was read at. */
  revision: number;
  /** Text and scripted Classes the letters and instances were built for. */
  signature: string;
  properties: Text2DProperties;
  count: number;
  letters: EngineObject[];
  modes: ScriptedClass[];
  decorators: Decorator[];
  instances: Map<string, EngineObject>;
  /** Poses the Appear Modes left, which Decorator Effects start from each tick. */
  appear: number[];
  /** The reveal position `appear` was computed at; NaN when it must be computed again. */
  appearProgress: number;
  /** The poses the renderer holds; empty while every letter is at rest. */
  sent: number[];
};

const REST = [0, 0, 1, 1, 0, 1, 1, 1, 1] as const;
const NO_POSES: number[] = [];
const NO_VALUES: ReadonlyMap<string, string> = new Map();
/** A letter's Tint at rest, shared: script colour values are never changed in place. */
const WHITE = Object.freeze({ x: 1, y: 1, z: 1, w: 1 });
const GET_KEYS = jsIdent(RICH_TEXT_GET_KEYS_FUNCTION.name);
const KEYS_OUTPUT = RICH_TEXT_GET_KEYS_FUNCTION.pins.find((pin) => pin.direction === "out" && pin.typeId !== "exec")!.name;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

function writePose(letter: EngineObject, poses: readonly number[], at: number): void {
  letter.setVariable("offset", { x: poses[at]!, y: poses[at + 1]! });
  letter.setVariable("scale", { x: poses[at + 2]!, y: poses[at + 3]! });
  letter.setVariable("rotation", poses[at + 4]!);
  letter.setVariable("opacity", poses[at + 5]!);
  const r = poses[at + 6]!, g = poses[at + 7]!, b = poses[at + 8]!;
  letter.setVariable("tint", r === 1 && g === 1 && b === 1 ? WHITE : { x: r, y: g, z: b, w: 1 });
}

/** A script colour (`{ x, y, z }`, `{ r, g, b }` or `[r, g, b]`) channel, clamped to 0..1; alpha is not read. */
function tintChannel(tint: unknown, index: 0 | 1 | 2): number {
  if (Array.isArray(tint)) return clampUnit(finite(tint[index], 1));
  if (!tint || typeof tint !== "object") return 1;
  const color = tint as Record<string, unknown>;
  return clampUnit(finite(color[index === 0 ? "x" : index === 1 ? "y" : "z"] ?? color[index === 0 ? "r" : index === 1 ? "g" : "b"], 1));
}

function readPoses(letters: readonly EngineObject[]): number[] {
  const poses: number[] = [];
  for (const letter of letters) {
    const offset = letter.getVariable("offset") as { x?: unknown; y?: unknown } | null | undefined;
    const scale = letter.getVariable("scale") as { x?: unknown; y?: unknown } | null | undefined;
    const tint = letter.getVariable("tint");
    poses.push(
      finite(offset?.x, 0), finite(offset?.y, 0), finite(scale?.x, 1), finite(scale?.y, 1),
      finite(letter.getVariable("rotation"), 0), clampUnit(finite(letter.getVariable("opacity"), 1)),
      tint === WHITE ? 1 : tintChannel(tint, 0), tint === WHITE ? 1 : tintChannel(tint, 1), tint === WHITE ? 1 : tintChannel(tint, 2),
    );
  }
  return poses;
}

/** The tag keywords a Decorator Effect declares with Get Keys: lower-cased, distinct, non-empty strings. */
function declaredKeys(outputs: Record<string, unknown> | null): readonly string[] {
  const keys = outputs?.[KEYS_OUTPUT];
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.flatMap((key) => typeof key === "string" && key.trim() ? [key.trim().toLowerCase()] : []))];
}

function atRest(poses: readonly number[]): boolean {
  return poses.every((value, index) => value === REST[index % TEXT2D_LETTER_POSE_STRIDE]);
}

function samePoses(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Runs Rich Text 2D Appear Mode and Decorator Effect Classes on a 2D Rich Text's letters. Scripts pose engine-made
 * Letter objects; the packed poses (`TEXT2D_LETTER_POSE_STRIDE` numbers per reveal character) are what the renderer
 * receives. Appear Modes run when the reveal moves, Decorator Effects every tick on top of what they left.
 */
export class Text2DLetterScripts {
  private host: Text2DLetterScriptsHost | null = null;
  private readonly states = new Map<ActorComponent, LetterState>();
  private readonly dirty = new Set<ActorComponent>();
  /** The variables revision at which a component was last found to script nothing. */
  private readonly idle = new WeakMap<ActorComponent, number>();
  /** The Decorator Effect whose `onDecorateLetters` runs now, and its tag's values by declared key. */
  private decorating: EngineObject | null = null;
  private tagValues: ReadonlyMap<string, string> = NO_VALUES;

  bind(host: Text2DLetterScriptsHost): void {
    this.host = host;
  }

  /** The poses the renderer holds for `component`, for an assignment that rebuilds its visual; undefined at rest. */
  poses(component: ActorComponent): number[] | undefined {
    const sent = this.states.get(component)?.sent;
    return sent?.length ? sent : undefined;
  }

  advance(component: ActorComponent, progress: number, deltaSeconds: number): void {
    const state = this.stateOf(component);
    if (!state) return;
    const host = this.host!;
    const moved = state.appearProgress !== progress;
    if (moved) {
      state.letters.forEach((letter) => writePose(letter, REST, 0));
      for (const mode of state.modes) {
        for (const letter of state.letters) {
          const alpha = text2DCharacterReveal(progress, letter.getVariable("index") as number, state.count, state.properties);
          host.invokeEvent(mode.classId, RICH_TEXT_LETTER_APPEAR_EVENT.exportName, mode.self, { letter, alpha });
        }
      }
      state.appear = readPoses(state.letters);
      state.appearProgress = progress;
    }
    if (state.decorators.length > 0) {
      if (!moved) state.letters.forEach((letter, index) => writePose(letter, state.appear, index * TEXT2D_LETTER_POSE_STRIDE));
      for (const decorator of state.decorators) {
        // Get Tag Value reads the values of this call's tag.
        const previousSelf = this.decorating, previousValues = this.tagValues;
        this.decorating = decorator.self;
        this.tagValues = decorator.values;
        try {
          host.invokeEvent(decorator.classId, RICH_TEXT_DECORATE_LETTERS_EVENT.exportName, decorator.self, {
            letters: [...decorator.letters], deltaSeconds, strength: decorator.strength,
          });
        } finally {
          this.decorating = previousSelf;
          this.tagValues = previousValues;
        }
      }
    } else if (!moved) return;
    const read = readPoses(state.letters);
    this.send(component, state, atRest(read) ? NO_POSES : read);
  }

  /** Get Tag Value: the value of `key` (any case) in the tag `self` decorates now; "" outside its decorate call. */
  tagValue(self: EngineObject | null, key: string): string {
    return self !== null && self === this.decorating ? this.tagValues.get(key.toLowerCase()) ?? "" : "";
  }

  flush(send: (component: ActorComponent, poses: number[]) => void): void {
    for (const component of this.dirty) {
      if (!component.destroyed && component.owner && !component.owner.destroyed) send(component, this.states.get(component)?.sent ?? NO_POSES);
    }
    this.dirty.clear();
  }

  remove(component: ActorComponent): void {
    const state = this.states.get(component);
    if (state) this.release(state);
    this.states.delete(component);
    this.dirty.delete(component);
  }

  private send(component: ActorComponent, state: LetterState, poses: number[]): void {
    if (samePoses(state.sent, poses)) return;
    state.sent = poses;
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
    const properties = parseText2DProperties(Object.fromEntries(component.variables), { rich: true });
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
    const letters: EngineObject[] = [];
    const decorators = new Map<string, Decorator>();
    // Each Decorator Effect's Get Keys, called once per build.
    const declared = new Map<string, readonly string[]>();
    const keysOf = (classId: string, self: EngineObject): readonly string[] => {
      let keys = declared.get(classId);
      if (!keys) declared.set(classId, keys = declaredKeys(this.host!.callFunction(self, GET_KEYS)));
      return keys;
    };
    for (const unit of units) {
      if (unit.kind === "lineBreak") continue;
      const letter = new EngineObject({
        classId: RICH_TEXT_2D_LETTER_CLASS_ID,
        guid: `${component.guid}:letter:${unit.index}`,
        variables: { index: unit.index, character: unit.kind === "glyph" ? unit.ch : "" },
      });
      writePose(letter, REST, 0);
      letters.push(letter);
      for (const effect of unit.effects.custom ?? []) {
        const self = instance(effect.name, RICH_TEXT_2D_DECORATOR_EFFECT_CLASS_ID);
        if (!self) continue;
        // Letters under one Strength and the same values of the Class's declared keys are decorated together, in
        // text order; keywords the Class does not declare do not split them.
        const keys = keysOf(effect.name, self);
        let group = `${effect.name}\0${effect.strength}`;
        for (const key of keys) group += `\0${Object.hasOwn(effect.attrs, key) ? effect.attrs[key] : ""}`;
        let decorator = decorators.get(group);
        if (!decorator) {
          const values = new Map<string, string>();
          for (const key of keys) if (Object.hasOwn(effect.attrs, key)) values.set(key, effect.attrs[key]!);
          decorators.set(group, decorator = { classId: effect.name, self, strength: effect.strength, letters: [], values });
        }
        decorator.letters.push(letter);
      }
    }
    const modes = modeIds.flatMap((classId): ScriptedClass[] => {
      const self = instance(classId, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID);
      return self ? [{ classId, self }] : [];
    });
    return {
      revision: 0, signature, properties, count: countText2DRevealCharacters(properties), letters, modes,
      decorators: [...decorators.values()], instances, appear: NO_POSES, appearProgress: Number.NaN,
      sent: previous?.sent ?? NO_POSES,
    };
  }
}

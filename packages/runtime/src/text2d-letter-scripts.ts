import {
  countText2DRevealCharacters, parseText2DProperties, text2DCharacterReveal, text2DCustomAppearModeClassId,
  text2DFormattedUnits, TEXT2D_LETTER_POSE_STRIDE, type Text2DProperties,
} from "@haptic/core";
import {
  EngineObject, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID, RICH_TEXT_2D_DECORATOR_EFFECT_CLASS_ID,
  RICH_TEXT_2D_LETTER_CLASS_ID, RICH_TEXT_DECORATE_LETTERS_EVENT, RICH_TEXT_LETTER_APPEAR_EVENT,
  type ActorComponent, type World,
} from "@haptic/object-model";

/** What letter scripting needs from the session: its World's classes and the script host's event dispatch. */
export interface Text2DLetterScriptsHost {
  world(): Pick<World, "classRegistry" | "createObject">;
  invokeEvent(classId: string, event: string, self: EngineObject, args: Record<string, unknown>): void;
}

type ScriptedClass = { classId: string; self: EngineObject };
type Decorator = ScriptedClass & { strength: number; letters: EngineObject[] };
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

const REST = [0, 0, 1, 1, 0, 1] as const;
const NO_POSES: number[] = [];

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function writePose(letter: EngineObject, poses: readonly number[], at: number): void {
  letter.setVariable("offset", { x: poses[at]!, y: poses[at + 1]! });
  letter.setVariable("scale", { x: poses[at + 2]!, y: poses[at + 3]! });
  letter.setVariable("rotation", poses[at + 4]!);
  letter.setVariable("opacity", poses[at + 5]!);
}

function readPoses(letters: readonly EngineObject[]): number[] {
  const poses: number[] = [];
  for (const letter of letters) {
    const offset = letter.getVariable("offset") as { x?: unknown; y?: unknown } | null | undefined;
    const scale = letter.getVariable("scale") as { x?: unknown; y?: unknown } | null | undefined;
    poses.push(
      finite(offset?.x, 0), finite(offset?.y, 0), finite(scale?.x, 1), finite(scale?.y, 1),
      finite(letter.getVariable("rotation"), 0), Math.min(1, Math.max(0, finite(letter.getVariable("opacity"), 1))),
    );
  }
  return poses;
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
        host.invokeEvent(decorator.classId, RICH_TEXT_DECORATE_LETTERS_EVENT.exportName, decorator.self, {
          letters: [...decorator.letters], deltaSeconds, strength: decorator.strength,
        });
      }
    } else if (!moved) return;
    const read = readPoses(state.letters);
    this.send(component, state, atRest(read) ? NO_POSES : read);
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
        // Letters under one tag strength are decorated together, in text order.
        const key = `${effect.name}\0${effect.strength}`;
        let decorator = decorators.get(key);
        if (!decorator) {
          const self = instance(effect.name, RICH_TEXT_2D_DECORATOR_EFFECT_CLASS_ID);
          if (!self) continue;
          decorators.set(key, decorator = { classId: effect.name, self, strength: effect.strength, letters: [] });
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

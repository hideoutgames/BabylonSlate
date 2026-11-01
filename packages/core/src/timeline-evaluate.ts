import { evaluateCurve, type ColorValue, type CurveKey, type RotatorValue, type Vec2Value, type Vec3Value } from "./curves";
import { eulerDegreesToQuaternion } from "./euler";
import type { SerializedActor, SerializedComponent, SerializedScene } from "./scene";
import type { SerializedTimelineClip, TimelinePropertyTrack } from "./timeline-clips";

/**
 * The Timeline evaluator, shared by the editor preview and Play so a scrubbed
 * view matches the game. Floats, vectors, rotators and colours interpolate with
 * each key's interpolation (the curve evaluator); booleans, integers, text,
 * enums and assets step. Before the first key a track holds the first key's
 * value, and after the last key the last key's.
 */

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const field = (value: unknown, name: string): number => num(value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined);

/** Rotator keys interpolate their authored degrees per axis (0 to 720 is two turns), as a vector. */
function rotatorAsVec3(value: unknown): Vec3Value {
  return { x: field(value, "pitch"), y: field(value, "yaw"), z: field(value, "roll") };
}

function vec2AsVec3(value: unknown): Vec3Value {
  return { x: field(value, "x"), y: field(value, "y"), z: 0 };
}

function mapKeys(keys: readonly CurveKey<unknown>[], map: (value: unknown) => Vec3Value): CurveKey<Vec3Value>[] {
  return keys.map((key) => ({ ...key, Value: map(key.Value), ArriveTangent: map(key.ArriveTangent), LeaveTangent: map(key.LeaveTangent) }));
}

/** The last key at or before `time`, or the first key before it starts. */
function steppedValue(keys: readonly CurveKey<unknown>[], time: number): unknown {
  let value = keys[0]!.Value;
  for (const key of keys) {
    if (key.Time > time) break;
    value = key.Value;
  }
  return value;
}

/** A track's value at `time` in its key format, or undefined when it has no keys. */
export function evaluateTimelineTrack(track: TimelinePropertyTrack, time: number): unknown {
  const keys = track.keys;
  if (keys.length === 0) return undefined;
  const curve = (curveKeys: readonly CurveKey<unknown>[]) => ({ Keys: curveKeys, Before: "constant", After: "constant" });
  switch (track.valueType) {
    case "float":
      return evaluateCurve("float", curve(keys), time);
    case "vec3":
      return evaluateCurve("vec3", curve(keys), time) satisfies Vec3Value;
    case "color":
      return evaluateCurve("color", curve(keys), time) satisfies ColorValue;
    case "vec2": {
      const value = evaluateCurve("vec3", curve(mapKeys(keys, vec2AsVec3)), time);
      return { x: value.x, y: value.y } satisfies Vec2Value;
    }
    case "rotator": {
      const value = evaluateCurve("vec3", curve(mapKeys(keys, rotatorAsVec3)), time);
      return { pitch: value.x, yaw: value.y, roll: value.z } satisfies RotatorValue;
    }
    default:
      return steppedValue(keys, time);
  }
}

const ARRAY_VALUE_TYPES = new Set<TimelinePropertyTrack["valueType"]>(["vec2", "vec3", "rotator", "color"]);

/**
 * The value in the shape `previous` is stored in. Class variables keep script
 * values (`{ x, y, z }`, `{ pitch, yaw, roll }`); component properties store
 * vectors, rotators and colours as arrays, and a colour keeps its 3 or 4
 * channels (as tweens do). An unset property takes its owner's usual shape.
 */
function storedValue(track: TimelinePropertyTrack, value: unknown, previous: unknown, arrays: boolean): unknown {
  if (!ARRAY_VALUE_TYPES.has(track.valueType)) return value;
  const asArray = Array.isArray(previous) || (arrays && (previous === undefined || previous === null));
  if (!asArray) return value;
  switch (track.valueType) {
    case "vec2": return [field(value, "x"), field(value, "y")];
    case "vec3": return [field(value, "x"), field(value, "y"), field(value, "z")];
    case "rotator": return [field(value, "pitch"), field(value, "yaw"), field(value, "roll")];
    default: {
      const channels = [field(value, "x"), field(value, "y"), field(value, "z"), field(value, "w")];
      const length = Array.isArray(previous) ? previous.length
        : track.target.property === "color" || track.target.property === "outlineColor" ? 3 : 4;
      return channels.slice(0, length === 3 ? 3 : 4);
    }
  }
}

function applyTrack(actor: SerializedActor, track: TimelinePropertyTrack, value: unknown): SerializedActor {
  const { target } = track;
  if (target.kind === "transform") {
    const transform = { ...actor.transform };
    if (target.property === "location") transform.position = [field(value, "x"), field(value, "y"), field(value, "z")];
    else if (target.property === "rotation") {
      transform.rotation = eulerDegreesToQuaternion([field(value, "pitch"), field(value, "yaw"), field(value, "roll")]);
    } else if (target.property === "scale") transform.scale = [field(value, "x"), field(value, "y"), field(value, "z")];
    else return actor;
    return { ...actor, transform };
  }
  if (target.kind === "visible") return { ...actor, visible: value === true };
  if (target.kind === "variable") {
    const stored = storedValue(track, value, actor.properties?.[target.property], false);
    return { ...actor, properties: { ...actor.properties, [target.property]: stored } };
  }
  const components = actor.components.map((component): SerializedComponent => component.id === target.componentId
    ? { ...component, properties: { ...component.properties, [target.property]: storedValue(track, value, component.properties[target.property], true) } }
    : component);
  return { ...actor, components };
}

/**
 * The scene as `clip` shows it at `time`, without changing `scene`: animated
 * actors are copied with their tracks' values, and every other actor is the same
 * object, so a transform-only change can take the renderer's pose path. Muted
 * tracks and tracks of actors the scene does not have are left out.
 */
export function applyTimelineClipToScene(scene: SerializedScene, clip: SerializedTimelineClip, time: number): SerializedScene {
  const animated = new Map(clip.objects.map((object) => [object.actorId, object]));
  let changed = false;
  const actors = scene.actors.map((actor) => {
    const object = animated.get(actor.id);
    if (!object) return actor;
    let next = actor;
    for (const track of object.tracks) {
      if (track.muted) continue;
      const value = evaluateTimelineTrack(track, time);
      if (value !== undefined) next = applyTrack(next, track, value);
    }
    if (next !== actor) changed = true;
    return next;
  });
  return changed ? { ...scene, actors } : scene;
}

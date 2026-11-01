import {
  evaluateTimelineTrack,
  quaternionToEulerDegrees,
  type SerializedActor,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelinePropertyTrack,
} from "@haptic/core";
import { applyLiveGizmoToActor, type LiveGizmoTransform } from "./gizmo-drag-commit";
import { setTimelineKeys, withTimelineClip, type NewId } from "./timeline-track-edits";

/**
 * A viewport gizmo edit while the viewport previews a Timeline Clip. Channels
 * (Location, Rotation, Scale) the clip animates take keys at the playhead with
 * Auto Key, or become unkeyed values without it; every other change edits the
 * document as in Design mode, so the animation is never baked into the actor.
 */
export interface TimelineTransformEdit {
  /** The scene to commit, or the same object when only unkeyed values changed. */
  scene: SerializedScene;
  /** Track id to the value the preview shows until it is keyed. */
  unkeyed: Map<string, unknown>;
}

type Channel = "location" | "rotation" | "scale";
const CHANNELS: readonly Channel[] = ["location", "rotation", "scale"];
const EPSILON = 1e-4;

const vec = (value: readonly number[]) => ({ x: value[0]!, y: value[1]!, z: value[2]! });
const num = (value: unknown, name: string) => {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
};

/** The authored rotator nearest `previous`, so a turn past 180° keys as 190, not -170. */
function unwrappedRotator(quaternion: readonly [number, number, number, number], previous: unknown) {
  const [pitch, yaw, roll] = quaternionToEulerDegrees([...quaternion] as [number, number, number, number]);
  const near = (value: number, target: number) => value + 360 * Math.round((target - value) / 360);
  return { pitch: near(pitch, num(previous, "pitch")), yaw: near(yaw, num(previous, "yaw")), roll: near(roll, num(previous, "roll")) };
}

function sameValue(a: unknown, b: unknown): boolean {
  const names = ["x", "y", "z", "pitch", "yaw", "roll"];
  return names.every((name) => Math.abs(num(a, name) - num(b, name)) < EPSILON);
}

function liveChannelValue(channel: Channel, live: LiveGizmoTransform, previous: unknown): unknown {
  if (channel === "location") return vec(live.position);
  if (channel === "scale") return vec(live.scale);
  return unwrappedRotator(live.rotation, previous);
}

export function timelineTransformEdit(
  scene: SerializedScene,
  clip: SerializedTimelineClip,
  time: number,
  lives: readonly LiveGizmoTransform[],
  options: {
    autoKey: boolean;
    unkeyed: ReadonlyMap<string, unknown>;
    newId: NewId;
    /** A track without keys leaves its channel to edit the actor (the clip asset Viewport's proxies). */
    keyedTracksOnly?: boolean;
  },
): TimelineTransformEdit {
  const unkeyed = new Map<string, unknown>();
  const keys: Array<{ trackId: string; time: number; value: unknown }> = [];
  const byId = new Map(lives.map((live) => [live.actorId, live]));
  const actors = scene.actors.map((actor): SerializedActor => {
    const live = byId.get(actor.id);
    if (!live) return actor;
    const edited = applyLiveGizmoToActor(actor, live);
    const tracks = new Map<Channel, TimelinePropertyTrack>();
    for (const track of clip.objects.find((object) => object.actorId === actor.id)?.tracks ?? []) {
      if (options.keyedTracksOnly && track.keys.length === 0) continue;
      if (!track.muted && track.target.kind === "transform" && CHANNELS.includes(track.target.property as Channel)) {
        tracks.set(track.target.property as Channel, track);
      }
    }
    if (tracks.size === 0) return edited;
    const transform = { ...edited.transform };
    for (const [channel, track] of tracks) {
      // The animated channel keeps its authored value in the document.
      if (channel === "location") transform.position = actor.transform.position;
      else if (channel === "rotation") transform.rotation = actor.transform.rotation;
      else transform.scale = actor.transform.scale;
      const shown = options.unkeyed.has(track.id) ? options.unkeyed.get(track.id) : evaluateTimelineTrack(track, time);
      const value = liveChannelValue(channel, live, shown);
      if (shown !== undefined && sameValue(value, shown)) continue;
      if (options.autoKey) keys.push({ trackId: track.id, time, value });
      else unkeyed.set(track.id, value);
    }
    return { ...edited, transform };
  });
  const changedActors = actors.some((actor, index) => actor !== scene.actors[index]
    && JSON.stringify(actor) !== JSON.stringify(scene.actors[index]));
  let next = changedActors ? { ...scene, actors } : scene;
  if (keys.length) next = withTimelineClip(next, setTimelineKeys(clip, keys, options.newId));
  return { scene: next, unkeyed };
}

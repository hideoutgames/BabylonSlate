import {
  MIN_TIMELINE_CLIP_LENGTH,
  TIMELINE_FRAME_RATES,
  type SerializedActor,
  type SerializedTimelineClip,
  type TimelineFrameRate,
  type TimelineKey,
  type TimelineLoopMode,
  type TimelinePropertyTrack,
  type TimelineWhenFinished,
} from "@haptic/core";
import { PanelFrame, PropertyGrid, frameAt, keyRefFromId, pinPickerLabel, snapToFrame, type PropertyRow } from "@haptic/editor-kit";
import { useRegistryState } from "../context/document-context";
import { useTimelineClip, useTimelinePropertyContext } from "../context/use-timeline-clip";
import { sceneActorDisplayNames } from "../lib/scene-actor-names";
import { TIMELINE_INTERPOLATION_OPTIONS, timelineInterpolationLabel } from "../lib/timeline-interpolation";
import { formatTimelineValue, timelinePropertyLabels, timelineTrackLabel } from "../lib/timeline-rows";
import { renameClip } from "../lib/timeline-clip-edits";
import {
  INTERPOLATED_VALUE_TYPES,
  findTimelineTrack,
  setTimelineKeyInterpolation,
  setTimelineKeyTime,
  setTimelineKeyValue,
  setTimelineTrackMuted,
  type TrackKeyRef,
} from "../lib/timeline-track-edits";

const LOOP_MODES: ReadonlyArray<{ value: TimelineLoopMode; label: string }> = [
  { value: "once", label: "Once" },
  { value: "loop", label: "Loop" },
  { value: "pingPong", label: "Ping Pong" },
];
const WHEN_FINISHED: ReadonlyArray<{ value: TimelineWhenFinished; label: string }> = [
  { value: "keep", label: "Keep State" },
  { value: "restore", label: "Restore State" },
];

const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const field = (value: unknown, name: string, fallback = 0) =>
  num(value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined, fallback);

/** The value row for a key, by the track's value type. */
function keyValueRow(track: TimelinePropertyTrack, key: TimelineKey, onChange: (value: unknown) => void, assetName: (guid: string) => string | undefined): PropertyRow {
  const id = "timeline-key-value";
  const value = key.Value;
  switch (track.valueType) {
    case "float":
      return { kind: "number", id, label: "Value", value: num(value), precision: 3, onChange };
    case "int":
      return { kind: "number", id, label: "Value", value: Math.round(num(value)), precision: 0, onChange: (next) => onChange(Math.round(next)) };
    case "bool":
      return { kind: "boolean", id, label: "Value", value: value === true, onChange };
    case "vec2":
      return { kind: "vector3", id, label: "Value", axes: ["X", "Y"], value: [field(value, "x"), field(value, "y"), 0],
        onChange: (next) => onChange({ x: next[0], y: next[1] }) };
    case "vec3":
      return { kind: "vector3", id, label: "Value", value: [field(value, "x"), field(value, "y"), field(value, "z")],
        onChange: (next) => onChange({ x: next[0], y: next[1], z: next[2] }) };
    case "rotator":
      return { kind: "vector3", id, label: "Value", unit: "°", value: [field(value, "pitch"), field(value, "yaw"), field(value, "roll")],
        onChange: (next) => onChange({ pitch: next[0], yaw: next[1], roll: next[2] }) };
    case "color":
      return { kind: "color4", id, label: "Value", value: [field(value, "x", 1), field(value, "y", 1), field(value, "z", 1), field(value, "w", 1)],
        onChange: (next) => onChange({ x: next[0], y: next[1], z: next[2], w: next[3] }) };
    case "string":
      return { kind: "text", id, label: "Value", value: typeof value === "string" ? value : "", onChange };
    default:
      return { kind: "text", id, label: "Value", value: formatTimelineValue(track.valueType, value, assetName), disabled: true, onChange: () => {},
        description: "Set it on the property, then key it." };
  }
}

function clipRows(clip: SerializedTimelineClip, commitClip: (clip: SerializedTimelineClip) => void, rename: (name: string) => void): PropertyRow[] {
  return [
    { kind: "text", id: "timeline-clip-name", label: "Name", value: clip.name, onChange: () => {}, onCommit: rename },
    { kind: "number", id: "timeline-clip-length", label: "Length", unit: "s", min: MIN_TIMELINE_CLIP_LENGTH, precision: 2, value: clip.length,
      onChange: (length) => commitClip({ ...clip, length: Math.max(MIN_TIMELINE_CLIP_LENGTH, length) }) },
    { kind: "enum", id: "timeline-clip-frame-rate", label: "Frame Rate", value: String(clip.frameRate),
      options: TIMELINE_FRAME_RATES.map((rate) => ({ value: String(rate), label: `${rate} fps` })),
      onChange: (rate) => commitClip({ ...clip, frameRate: Number(rate) as TimelineFrameRate }) },
    { kind: "number", id: "timeline-clip-play-rate", label: "Play Rate", min: 0, precision: 2, value: clip.playRate,
      onChange: (playRate) => commitClip({ ...clip, playRate: Math.max(0, playRate) }) },
    { kind: "enum", id: "timeline-clip-loop-mode", label: "Loop Mode", value: clip.loopMode, options: [...LOOP_MODES],
      onChange: (loopMode) => commitClip({ ...clip, loopMode: loopMode as TimelineLoopMode }) },
    { kind: "boolean", id: "timeline-clip-auto-play", label: "Auto Play", value: clip.autoPlay,
      onChange: (autoPlay) => commitClip({ ...clip, autoPlay }) },
    { kind: "enum", id: "timeline-clip-when-finished", label: "When Finished", value: clip.whenFinished, options: [...WHEN_FINISHED],
      onChange: (whenFinished) => commitClip({ ...clip, whenFinished: whenFinished as TimelineWhenFinished }) },
  ];
}

/**
 * The Inspector in Timeline mode while a clip is selected: the selected key
 * (or keys, or track), then the clip's settings.
 */
export function TimelineInspector() {
  const { scene, clip, commitClip, commitScene, tools } = useTimelineClip();
  const property = useTimelinePropertyContext();
  const { assetRegistry } = useRegistryState();
  if (!scene || !clip) return null;
  const assetName = (guid: string) => assetRegistry?.getByGuid?.(guid)?.header.name;
  const actorNames = sceneActorDisplayNames(scene);
  const actorOf = (actorId: string): SerializedActor | undefined => scene.actors.find((actor) => actor.id === actorId);
  const trackTitle = (trackId: string) => {
    const found = findTimelineTrack(clip, trackId);
    if (!found) return "";
    const actor = actorOf(found.object.actorId);
    const labels = timelinePropertyLabels(actor, { graphs: property.graphs, parentOf: property.parentOf });
    const label = timelineTrackLabel(actor, found.track, labels);
    return `${actor ? actorNames.get(actor.id) ?? actor.name : "Missing Actor"} › ${label}`;
  };

  // Only keys the clip still has.
  const keys = [...tools.timelineKeySelection].map(keyRefFromId).flatMap((ref): Array<TrackKeyRef & { track: TimelinePropertyTrack; key: TimelineKey }> => {
    const track = findTimelineTrack(clip, ref.rowId)?.track;
    const key = track?.keys.find((entry) => entry.id === ref.keyId);
    return track && key ? [{ trackId: track.id, keyId: key.id, track, key }] : [];
  });

  const grids: Array<{ title: string; rows: PropertyRow[]; testId: string }> = [];
  if (keys.length === 1) {
    const [{ track, key, trackId, keyId }] = keys as [typeof keys[number]];
    const ref = { trackId, keyId };
    const rows: PropertyRow[] = [
      { kind: "text", id: "timeline-key-track", label: "Track", value: trackTitle(trackId), disabled: true, onChange: () => {} },
      { kind: "number", id: "timeline-key-time", label: "Time", unit: "s", min: 0, max: clip.length, precision: 2, value: key.Time,
        labelAccessory: <span className="font-mono text-[11px] text-muted-foreground tabular-nums">Frame {frameAt(key.Time, clip.frameRate)}</span>,
        onChange: (time) => commitClip(setTimelineKeyTime(clip, ref, snapToFrame(time, clip.frameRate, clip.length))) },
      keyValueRow(track, key, (value) => commitClip(setTimelineKeyValue(clip, ref, value)), assetName),
    ];
    if (INTERPOLATED_VALUE_TYPES.has(track.valueType)) {
      const options = TIMELINE_INTERPOLATION_OPTIONS.some((option) => option.value === key.Interpolation)
        ? [...TIMELINE_INTERPOLATION_OPTIONS]
        : [...TIMELINE_INTERPOLATION_OPTIONS, { value: key.Interpolation, label: timelineInterpolationLabel(key.Interpolation) }];
      rows.push({ kind: "enum", id: "timeline-key-interpolation", label: "Interpolation", value: key.Interpolation, options,
        description: "How the value moves to the next key.",
        onChange: (value) => commitClip(setTimelineKeyInterpolation(clip, [ref], value as TimelineKey["Interpolation"])) });
    }
    grids.push({ title: "Key", rows, testId: "timeline-inspector-key" });
  } else if (keys.length > 1) {
    const interpolated = keys.filter((entry) => INTERPOLATED_VALUE_TYPES.has(entry.track.valueType));
    const values = new Set(interpolated.map((entry) => entry.key.Interpolation));
    const rows: PropertyRow[] = interpolated.length ? [{
      kind: "enum", id: "timeline-keys-interpolation", label: "Interpolation",
      value: values.size === 1 ? [...values][0]! : "", mixed: values.size > 1, options: [...TIMELINE_INTERPOLATION_OPTIONS],
      onChange: (value) => commitClip(setTimelineKeyInterpolation(clip, interpolated, value as TimelineKey["Interpolation"])),
    }] : [];
    grids.push({ title: `${keys.length} Keys`, rows, testId: "timeline-inspector-keys" });
  } else if (tools.timelineRowId) {
    const found = findTimelineTrack(clip, tools.timelineRowId);
    if (found) {
      grids.push({ title: "Track", testId: "timeline-inspector-track", rows: [
        { kind: "text", id: "timeline-track-property", label: "Property", value: trackTitle(found.track.id), disabled: true, onChange: () => {} },
        { kind: "text", id: "timeline-track-type", label: "Type", value: pinPickerLabel(found.track.valueType), disabled: true, onChange: () => {} },
        { kind: "number", id: "timeline-track-keys", label: "Keys", value: found.track.keys.length, disabled: true, onChange: () => {} },
        { kind: "boolean", id: "timeline-track-muted", label: "Muted", value: found.track.muted === true,
          description: "A muted track keeps its keys but does not animate.",
          onChange: (muted) => commitClip(setTimelineTrackMuted(clip, found.track.id, muted)) },
      ] });
    }
  }
  grids.push({
    title: "Timeline Clip",
    testId: "timeline-inspector-clip",
    rows: clipRows(clip, commitClip, (name) => commitScene(renameClip(scene, clip.id, name))),
  });

  return <PanelFrame data-testid="scene-details-panel">
    <div className="flex flex-col gap-3 pb-4" data-testid="timeline-inspector">
      {grids.map((grid) => <PropertyGrid key={grid.testId} title={grid.title} rows={grid.rows} data-testid={grid.testId} />)}
      {keys.length === 0 && !tools.timelineRowId ? (
        <p className="px-2 text-xs text-muted-foreground">Select a key or track in the Timeline to edit it here.</p>
      ) : null}
    </div>
  </PanelFrame>;
}

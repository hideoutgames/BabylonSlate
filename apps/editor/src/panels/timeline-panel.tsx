import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  MIN_TIMELINE_CLIP_LENGTH,
  TIMELINE_FRAME_RATES,
  type SerializedActor,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelineFrameRate,
  type TimelineKey,
} from "@haptic/core";
import {
  ChecklistDialog,
  ContextMenuOverlay,
  CurveEditor,
  TreeView,
  KeyframeTimeline,
  NestedMenu,
  NumberField,
  PanelFrame,
  SearchInput,
  ToolbarStrip,
  TypeColorMark,
  TypeVisualIcon,
  keyRefFromId,
  keyRefId,
  pinPickerColorVar,
  pinPickerLabel,
  resolveActorTypeVisual,
  useContextMenu,
  useTouchUi,
  walkAncestry,
  type ChecklistDialogGroup,
  type ContextMenuItem,
  type KeyRef,
  type KeySelectMode,
  type KeyframeTimelineTrackRow,
  type NestedMenuItem,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@haptic/ui/components/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { Toggle } from "@haptic/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  ChevronDownIcon,
  CircleDotIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  CrosshairIcon,
  ListChecksIcon,
  LocateIcon,
  MousePointerClickIcon,
  ScissorsIcon,
  SplineIcon,
  UnfoldHorizontalIcon,
  DiamondIcon,
  DiamondPlusIcon,
  FilmIcon,
  MagnetIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  SkipBackIcon,
  SkipForwardIcon,
  StepBackIcon,
  StepForwardIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Volume2Icon,
  VolumeXIcon,
  ZapIcon,
} from "lucide-react";
import { IconActionButton } from "../components/icon-action-button";
import { useRegistryState } from "../context/document-context";
import { useEditorSessionState } from "../context/editor-session-state-context";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { useSceneTools } from "../context/scene-tools-context";
import { sceneActorDisplayNames } from "../lib/scene-actor-names";
import {
  authoredTimelineValue,
  timelinePropertyGroups,
  timelineTargetKey,
  timelineTrackProblemText,
  type TimelinePropertyContext,
} from "../lib/timeline-property-catalog";
import { useTimelinePlayheadTime } from "../lib/timeline-playhead";
import { laneSelection, timelineRows, trackKeyRefs, type TimelineRowModel } from "../lib/timeline-rows";
import {
  addTimelineObjects,
  addTimelineTracks,
  adjacentTimelineKeyTime,
  clampTimelineKeyShift,
  deleteTimelineKeys,
  findTimelineTrack,
  moveTimelineRow,
  pasteTimelineTrack,
  removeTimelineObject,
  removeTimelineTrack,
  setTimelineKeyInterpolation,
  timelineRowKeyRefs,
  setTimelineKeys,
  setTimelineTrackMuted,
  shiftTimelineKeys,
  snapshotTimelineKeys,
  timelineKeyAt,
  timelineKeyTimes,
  timelineKeyValueAt,
  type TrackKeyRef,
} from "../lib/timeline-track-edits";
import { TIMELINE_EASE_SHORTCUTS, TIMELINE_EASING_CURVES, timelineInterpolationLabel } from "../lib/timeline-interpolation";
import { applyTimelineCurve, timelineCurveChannels, timelineCurveKind, timelineTrackCurve } from "../lib/timeline-curves";
import { useTimelineClip, useTimelinePropertyContext } from "../context/use-timeline-clip";
import {
  TIMELINE_EVENTS_ROW_ID,
  addTimelineEventTrack,
  clampTimelineEventKeyShift,
  deleteTimelineEventKeys,
  copyTimelineSelectedKeys,
  findTimelineEventTrack,
  moveTimelineEventTrack,
  pasteTimelineSelectedKeys,
  removeTimelineEventTrack,
  setTimelineEventKeys,
  shiftTimelineEventKeys,
  snapshotTimelineEventKeys,
  timelineEventKeyAt,
  timelineEventKeyRefs,
  timelineEventKeyTimes,
  toggleTimelineEventKey,
  type TimelineEventKey,
} from "../lib/timeline-event-edits";

const newId = () => crypto.randomUUID();

/** A row that cannot animate reads in red, with why in its tooltip. */
function problemLabel(row: TimelineRowModel): React.ReactNode {
  if (!row.problem) return row.label;
  return <span className="text-destructive" title={timelineTrackProblemText(row.problem)} data-problem={row.problem}>{row.label}</span>;
}

function TransportButton({ label, shortcut, onClick, disabled, children, testId }: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  return <IconActionButton label={label} shortcut={shortcut} variant="ghost" size="icon-sm" disabled={disabled} onClick={onClick} data-testid={testId}>
    {children}
  </IconActionButton>;
}

/** Timeline mode: the selected clip's keyframe timeline. */
export function TimelinePanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene, clips, clip, commitClip, tools, proxies } = useTimelineClip();
  if (!scene || !clip) {
    return <PanelFrame>
      <Empty className="h-full gap-3 p-4" data-testid="scene-timeline-panel">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FilmIcon /></EmptyMedia>
          <EmptyTitle data-testid="scene-timeline-title">{clips.length ? "No Clip Selected" : "No Timeline Clips"}</EmptyTitle>
          <EmptyDescription>{clips.length ? "Pick a clip in Clips to show its timeline." : "Create a clip in Clips."}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PanelFrame>;
  }
  return <ClipTimeline key={clip.id} scene={scene} clip={clip} commitClip={commitClip} tools={tools} proxies={proxies} />;
}

function ClipTimeline({ scene, clip, commitClip, tools, proxies = false }: {
  scene: SerializedScene;
  clip: SerializedTimelineClip;
  commitClip: (clip: SerializedTimelineClip) => void;
  tools: ReturnType<typeof useSceneTools>;
  /** A clip asset's: every row is a proxy, kept while the proxy exists. */
  proxies?: boolean;
}) {
  const session = useEditorSessionState();
  const keybinds = useKeybindings();
  const touch = useTouchUi();
  const sceneEditing = useOptionalSceneEditing();
  const selectedActorIds = sceneEditing?.selectedActorIds ?? [];
  const { assetRegistry } = useRegistryState();
  const property = useTimelinePropertyContext();
  const playhead = tools.timelinePlayhead;
  const rawTime = useTimelinePlayheadTime(playhead);
  const time = Math.min(clip.length, Math.max(0, rawTime));
  const { timelineKeySelection: selection, setTimelineKeySelection: setSelection, timelineRowId: rowId, setTimelineRowId: setRowId } = tools;
  const { timelineAutoKey: autoKey, setTimelineAutoKey: setAutoKey, timelineUnkeyed: unkeyed, setTimelineUnkeyed: setUnkeyed } = tools;
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [snap, setSnap] = useState(true);
  const [looping, setLooping] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [addTrackActorId, setAddTrackActorId] = useState<string | null>(null);
  const [pickActorOpen, setPickActorOpen] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  // Keys: the key lanes. Curves: the selected track's curves, with tangent handles.
  const [view, setView] = useState<"keys" | "curves">("keys");
  const lengthDrag = useRef<number | null>(null);
  const drag = useRef<{ base: SerializedTimelineClip; snapshot: Map<string, TimelineKey[]>; events: Map<string, TimelineEventKey[]> } | null>(null);
  const clipRef = useRef(clip);
  clipRef.current = clip;

  const actorNames = useMemo(() => sceneActorDisplayNames(scene), [scene]);
  const actorName = useCallback((actor: SerializedActor) => actorNames.get(actor.id) ?? actor.name, [actorNames]);
  const contextFor = useCallback((actor: SerializedActor): TimelinePropertyContext => ({
    graphs: property.graphs,
    parentOf: property.parentOf,
    classLabel: property.classLabel(actor.classId),
  }), [property]);
  const assetName = useCallback((guid: string) => assetRegistry?.getByGuid?.(guid)?.header.name, [assetRegistry]);

  // A new clip starts with nothing selected; the playhead stays inside it.
  useEffect(() => {
    setSelection(new Set());
    setRowId(null);
    if (playhead.get() > clip.length) playhead.set(clip.length);
    // Only when the clip changes; this component is keyed by clip id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => timelineRows({
    scene,
    clip,
    time,
    collapsed,
    filter,
    actorName,
    context: { graphs: property.graphs, parentOf: property.parentOf },
    assetName,
  }), [scene, clip, time, collapsed, filter, actorName, property, assetName]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  // Playback previews the clip at its Play Rate; it stops at the end unless Loop is on.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    if (playhead.get() >= clipRef.current.length) playhead.set(0);
    const step = (now: number) => {
      const current = clipRef.current;
      const next = playhead.get() + ((now - last) / 1000) * current.playRate;
      last = now;
      if (next >= current.length) {
        if (looping && current.length > 0) playhead.set(next % current.length);
        else {
          playhead.set(current.length);
          setPlaying(false);
          return;
        }
      } else playhead.set(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [looping, playhead, playing]);

  const selectedTrackRefs = useCallback((): TrackKeyRef[] =>
    [...selection].map((id) => keyRefFromId(id)).map((ref) => ({ trackId: ref.rowId, keyId: ref.keyId })), [selection]);

  const selectKeys = (refs: KeyRef[], mode: KeySelectMode) => {
    const expanded = trackKeyRefs(clip, refs).map((ref) => keyRefId({ rowId: ref.trackId, keyId: ref.keyId }));
    setSelection((() => {
      const next = new Set(mode === "replace" ? [] : selection);
      for (const id of expanded) {
        if (mode === "toggle" && selection.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    })());
  };

  const moveKeys = (delta: number, phase: "start" | "move" | "end" | "cancel") => {
    if (phase === "start") {
      const refs = selectedTrackRefs();
      drag.current = { base: clip, snapshot: snapshotTimelineKeys(clip, refs), events: snapshotTimelineEventKeys(clip, refs) };
      return;
    }
    const held = drag.current;
    if (!held) return;
    // Property and event keys move together, as far as both stay inside the clip.
    let shift = phase === "cancel" ? 0 : delta;
    if (held.snapshot.size) shift = clampTimelineKeyShift(held.snapshot, shift, held.base.length);
    if (held.events.size) shift = clampTimelineEventKeyShift(held.events, shift, held.base.length);
    commitClip(shiftTimelineEventKeys(shiftTimelineKeys(held.base, held.snapshot, shift), held.events, shift));
    if (phase !== "move") drag.current = null;
  };

  /** The tracks a command acts on: the selected row's (an object's are all of its tracks), else the selected keys' tracks. */
  const targetTrackIds = (): string[] => {
    const row = rowId ? clip.objects.find((object) => object.id === rowId) : undefined;
    if (row) return row.tracks.map((track) => track.id);
    if (rowId === TIMELINE_EVENTS_ROW_ID) return clip.eventTracks.map((track) => track.id);
    if (rowId && (findTimelineTrack(clip, rowId) || findTimelineEventTrack(clip, rowId))) return [rowId];
    return [...new Set(selectedTrackRefs().map((ref) => ref.trackId))];
  };

  const keyValue = (trackId: string, at: number) => {
    // An unkeyed change is what the viewport shows, so keying keeps it.
    if (unkeyed.has(trackId)) return unkeyed.get(trackId);
    const found = findTimelineTrack(clip, trackId);
    if (!found) return undefined;
    const actor = scene.actors.find((entry) => entry.id === found.object.actorId);
    const authored = actor ? authoredTimelineValue(actor, found.track.target, found.track.valueType, contextFor(actor)) : undefined;
    return timelineKeyValueAt(found.track, at, authored);
  };

  const setKeys = (trackIds: readonly string[]) => {
    const keys = trackIds.flatMap((trackId) => {
      const value = keyValue(trackId, time);
      return value === undefined ? [] : [{ trackId, time, value }];
    });
    // Event tracks get a key at the playhead; its values start at the inputs' defaults.
    const eventTrackIds = trackIds.filter((trackId) => findTimelineEventTrack(clip, trackId));
    let next = keys.length ? setTimelineKeys(clip, keys, newId) : clip;
    if (eventTrackIds.length) next = setTimelineEventKeys(next, eventTrackIds, time, newId).clip;
    if (next !== clip) commitClip(next);
    if (trackIds.some((trackId) => unkeyed.has(trackId))) {
      setUnkeyed(new Map([...unkeyed].filter(([trackId]) => !trackIds.includes(trackId))));
    }
  };

  /** A track row's key button: keys an unkeyed change, else removes the key on the playhead's frame, or sets one. */
  const toggleKey = (trackId: string) => {
    if (findTimelineEventTrack(clip, trackId)) {
      commitClip(toggleTimelineEventKey(clip, trackId, time, newId));
      return;
    }
    const track = findTimelineTrack(clip, trackId)?.track;
    if (!track) return;
    const existing = timelineKeyAt(track, time, clip.frameRate);
    if (unkeyed.has(trackId)) {
      setKeys([trackId]);
      return;
    }
    if (existing) commitClip(deleteTimelineKeys(clip, [{ trackId, keyId: existing.id }]));
    else setKeys([trackId]);
  };

  const jumpToKey = (direction: 1 | -1) => {
    const target = adjacentTimelineKeyTime([...timelineKeyTimes(clip), ...timelineEventKeyTimes(clip)], time, direction, clip.frameRate);
    if (target !== undefined) playhead.set(target);
  };

  const deleteSelection = () => {
    if (selection.size > 0) {
      const refs = selectedTrackRefs();
      commitClip(deleteTimelineEventKeys(deleteTimelineKeys(clip, refs), refs));
      setSelection(new Set());
      return;
    }
    if (!rowId || rowId === TIMELINE_EVENTS_ROW_ID) return;
    if (findTimelineEventTrack(clip, rowId)) {
      commitClip(removeTimelineEventTrack(clip, rowId));
      setRowId(null);
      return;
    }
    const object = clip.objects.find((entry) => entry.id === rowId);
    // A proxy's row stays while the proxy does; Delete removes it in Proxies.
    if (object && proxies) return;
    commitClip(object ? removeTimelineObject(clip, rowId) : removeTimelineTrack(clip, rowId));
    setRowId(null);
  };

  const copyKeys = (refs: readonly TrackKeyRef[] = selectedTrackRefs()) => {
    const copied = copyTimelineSelectedKeys(clip, refs);
    if (copied) session.copyTimelineKeys(copied);
  };
  const pasteKeys = () => {
    const copied = session.readCopiedTimelineKeys();
    if (!copied) return;
    const { clip: next, pasted } = pasteTimelineSelectedKeys(clip, copied, time, newId);
    commitClip(next);
    setSelection(new Set(pasted.map((ref) => keyRefId({ rowId: ref.trackId, keyId: ref.keyId }))));
  };
  const deleteKeys = (refs: readonly TrackKeyRef[] = selectedTrackRefs()) => {
    commitClip(deleteTimelineEventKeys(deleteTimelineKeys(clip, refs), refs));
    setSelection(new Set());
  };
  /** Copy and paste at the playhead in one step, without changing what Copy last stored. */
  const duplicateKeys = (refs: readonly TrackKeyRef[] = selectedTrackRefs()) => {
    const copied = copyTimelineSelectedKeys(clip, refs);
    if (!copied) return;
    const { clip: next, pasted } = pasteTimelineSelectedKeys(clip, copied, time, newId);
    commitClip(next);
    setSelection(new Set(pasted.map((ref) => keyRefId({ rowId: ref.trackId, keyId: ref.keyId }))));
  };

  const commitRef = useRef(commitClip);
  commitRef.current = commitClip;
  const addActors = useCallback((actorIds: readonly string[]) => {
    const current = clipRef.current;
    const next = addTimelineObjects(current, actorIds, newId);
    if (next !== current) commitRef.current(next);
  }, []);

  // While it shows this clip, the window is where Outliner rows join it.
  const { setTimelineDropTarget } = tools;
  useEffect(() => {
    setTimelineDropTarget({
      containsClientPoint: (x, y) => {
        const rect = rootRef.current?.getBoundingClientRect();
        return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      },
      clipName: () => clipRef.current.name,
      addActors,
    });
    return () => setTimelineDropTarget(null);
  }, [addActors, setTimelineDropTarget]);

  const selectedActors = selectedActorIds.filter((id) => scene.actors.some((actor) => actor.id === id));
  const focus = { focusWithinRef: rootRef };
  useKeybindCommand("timeline.setKey", () => setKeys(targetTrackIds()), { ...focus, enabled: () => targetTrackIds().length > 0 });
  useKeybindCommand("timeline.previousKey", () => jumpToKey(-1), focus);
  useKeybindCommand("timeline.nextKey", () => jumpToKey(1), focus);
  useKeybindCommand("edit.delete", deleteSelection, { ...focus, enabled: () => selection.size > 0 || (rowId !== null && rowId !== TIMELINE_EVENTS_ROW_ID) });
  useKeybindCommand("edit.copy", () => copyKeys(), { ...focus, enabled: () => selection.size > 0 });
  useKeybindCommand("edit.duplicate", () => duplicateKeys(), { ...focus, enabled: () => selection.size > 0 });
  useKeybindCommand("edit.paste", pasteKeys, focus);
  // The selection is made in the Outliner or the viewport, so this works while the window is shown.
  useKeybindCommand("timeline.addSelectedActors", () => addActors(selectedActors), {
    scopeRef: rootRef,
    enabled: () => selectedActors.some((id) => !clip.objects.some((object) => object.actorId === id)),
  });

  const { menu, closeMenu, openMenuAt } = useContextMenu({ items: () => [] });
  const rowKeyRefs = (id: string): TrackKeyRef[] => id === TIMELINE_EVENTS_ROW_ID
    ? timelineEventKeyRefs(clip)
    : findTimelineEventTrack(clip, id) ? timelineEventKeyRefs(clip, id) : timelineRowKeyRefs(clip, id);
  const selectRowKeys = (id: string) => setSelection(new Set(rowKeyRefs(id).map((ref) => keyRefId({ rowId: ref.trackId, keyId: ref.keyId }))));
  const addEventTrack = () => {
    const added = addTimelineEventTrack(clip, newId);
    commitClip(added.clip);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(TIMELINE_EVENTS_ROW_ID);
      return next;
    });
    // The Inspector names it and adds its inputs.
    setSelection(new Set());
    setRowId(added.trackId);
  };
  const moveItems = (id: string): ContextMenuItem[] => [
    { id: "move-up", label: "Move Up", icon: <ArrowUpIcon />, disabled: moveTimelineRow(clip, id, -1) === clip, testId: "timeline-row-menu-up",
      onSelect: () => commitClip(moveTimelineRow(clip, id, -1)) },
    { id: "move-down", label: "Move Down", icon: <ArrowDownIcon />, disabled: moveTimelineRow(clip, id, 1) === clip, testId: "timeline-row-menu-down",
      onSelect: () => commitClip(moveTimelineRow(clip, id, 1)) },
  ];
  const copyTrack = (trackId: string) => {
    const found = findTimelineTrack(clip, trackId);
    if (!found) return;
    const actor = scene.actors.find((entry) => entry.id === found.object.actorId);
    const component = actor?.components.find((entry) => entry.id === found.track.target.componentId);
    session.copyTimelineTrack({
      target: found.track.target,
      valueType: found.track.valueType,
      ...(component ? { componentClassId: component.classId } : {}),
      keys: found.track.keys,
    });
  };
  const pasteTrack = (objectId: string) => {
    const copied = session.readCopiedTimelineTrack();
    const object = clip.objects.find((entry) => entry.id === objectId);
    const actor = object && scene.actors.find((entry) => entry.id === object.actorId);
    if (!copied || !actor) return;
    const next = pasteTimelineTrack(clip, objectId, copied, actor, newId);
    if (next) commitClip(next);
  };
  const eventRowMenuItems = (row: TimelineRowModel): ContextMenuItem[] => {
    if (row.id === TIMELINE_EVENTS_ROW_ID) {
      return [
        { id: "add-event-track", label: "Add Custom Event Track", icon: <PlusIcon />, testId: "timeline-row-menu-add-event-track", onSelect: addEventTrack },
        { id: "set-key", label: "Set Key", icon: <DiamondPlusIcon />, shortcut: keybinds.get("timeline.setKey")?.[0], testId: "timeline-row-menu-set-key",
          onSelect: () => setKeys(clip.eventTracks.map((track) => track.id)) },
        { id: "select-keys", label: "Select All Keys", icon: <ListChecksIcon />, disabled: timelineEventKeyRefs(clip).length === 0,
          testId: "timeline-row-menu-select-keys", onSelect: () => selectRowKeys(row.id) },
      ];
    }
    return [
      { id: "set-key", label: "Set Key", icon: <DiamondPlusIcon />, shortcut: keybinds.get("timeline.setKey")?.[0], testId: "timeline-row-menu-set-key",
        onSelect: () => setKeys([row.id]) },
      { id: "select-keys", label: "Select All Keys", icon: <ListChecksIcon />, disabled: !row.eventTrack?.keys.length,
        testId: "timeline-row-menu-select-keys", onSelect: () => selectRowKeys(row.id) },
      { type: "separator", id: "move-separator" },
      { id: "move-up", label: "Move Up", icon: <ArrowUpIcon />, disabled: moveTimelineEventTrack(clip, row.id, -1) === clip, testId: "timeline-row-menu-up",
        onSelect: () => commitClip(moveTimelineEventTrack(clip, row.id, -1)) },
      { id: "move-down", label: "Move Down", icon: <ArrowDownIcon />, disabled: moveTimelineEventTrack(clip, row.id, 1) === clip, testId: "timeline-row-menu-down",
        onSelect: () => commitClip(moveTimelineEventTrack(clip, row.id, 1)) },
      { type: "separator", id: "delete-separator" },
      { id: "delete-track", label: "Delete Track", icon: <Trash2Icon />, variant: "destructive", testId: "timeline-row-menu-delete",
        onSelect: () => commitClip(removeTimelineEventTrack(clip, row.id)) },
    ];
  };
  const rowMenuItems = (row: TimelineRowModel): ContextMenuItem[] => {
    if (row.objectId === TIMELINE_EVENTS_ROW_ID) return eventRowMenuItems(row);
    // The viewport and the Outliner share the scene selection.
    const reveal: ContextMenuItem = { id: "reveal", label: "Select in Viewport and Outliner", icon: <LocateIcon />, disabled: !row.actor || !sceneEditing,
      testId: "timeline-row-menu-reveal", onSelect: () => { if (row.actor) sceneEditing?.selectActor(row.actor.id); } };
    if (row.kind === "group") {
      const tracks = clip.objects.find((object) => object.id === row.id)?.tracks ?? [];
      return [
        { id: "add-track", label: "Add Track…", icon: <PlusIcon />, disabled: !row.actor, testId: "timeline-row-menu-add-track",
          onSelect: () => row.actor && setAddTrackActorId(row.actor.id) },
        { id: "set-key", label: "Set Key", icon: <DiamondPlusIcon />, shortcut: keybinds.get("timeline.setKey")?.[0],
          disabled: tracks.length === 0, testId: "timeline-row-menu-set-key", onSelect: () => setKeys(tracks.map((track) => track.id)) },
        { id: "paste-track", label: "Paste Track", icon: <ClipboardPasteIcon />, testId: "timeline-row-menu-paste-track",
          disabled: !session.readCopiedTimelineTrack() || !row.actor, onSelect: () => pasteTrack(row.id) },
        { id: "select-keys", label: "Select All Keys", icon: <ListChecksIcon />, disabled: tracks.every((track) => track.keys.length === 0),
          testId: "timeline-row-menu-select-keys", onSelect: () => selectRowKeys(row.id) },
        // A proxy has no scene actor to select, and leaves the clip only from Proxies.
        ...(proxies ? [] : [reveal]),
        { type: "separator", id: "move-separator" },
        ...moveItems(row.id),
        ...(proxies ? [] : [
          { type: "separator" as const, id: "remove-separator" },
          { id: "remove-object", label: "Remove From Clip", icon: <Trash2Icon />, variant: "destructive" as const, testId: "timeline-row-menu-remove",
            onSelect: () => commitClip(removeTimelineObject(clip, row.id)) },
        ]),
      ];
    }
    const muted = row.track?.muted === true;
    return [
      { id: "set-key", label: "Set Key", icon: <DiamondPlusIcon />, shortcut: keybinds.get("timeline.setKey")?.[0], testId: "timeline-row-menu-set-key",
        onSelect: () => setKeys([row.id]) },
      { id: "mute-track", label: muted ? "Unmute Track" : "Mute Track", icon: muted ? <Volume2Icon /> : <VolumeXIcon />, testId: "timeline-row-menu-mute",
        onSelect: () => commitClip(setTimelineTrackMuted(clip, row.id, !muted)) },
      { id: "copy-track", label: "Copy Track", icon: <CopyIcon />, testId: "timeline-row-menu-copy-track", onSelect: () => copyTrack(row.id) },
      { id: "select-keys", label: "Select All Keys", icon: <ListChecksIcon />, disabled: !row.track?.keys.length,
        testId: "timeline-row-menu-select-keys", onSelect: () => selectRowKeys(row.id) },
      ...(proxies ? [] : [reveal]),
      { type: "separator", id: "move-separator" },
      ...moveItems(row.id),
      { type: "separator", id: "delete-separator" },
      { id: "delete-track", label: "Delete Track", icon: <Trash2Icon />, variant: "destructive", testId: "timeline-row-menu-delete",
        onSelect: () => commitClip(removeTimelineTrack(clip, row.id)) },
    ];
  };

  const keyMenuItems = (ref: KeyRef): ContextMenuItem[] => {
    // The menu acts on the selection when the key is in it; otherwise the press just selected this key alone.
    const clicked = trackKeyRefs(clip, [ref]);
    const inSelection = clicked.length > 0 && clicked.every((entry) => selection.has(keyRefId({ rowId: entry.trackId, keyId: entry.keyId })));
    const targets = inSelection ? selectedTrackRefs() : clicked;
    const setInterpolation = (value: TimelineKey["Interpolation"]) => commitClip(setTimelineKeyInterpolation(clip, targets, value));
    const keyTime = clicked.map((entry) => findTimelineTrack(clip, entry.trackId)?.track.keys.find((key) => key.id === entry.keyId)?.Time
      ?? findTimelineEventTrack(clip, entry.trackId)?.keys.find((key) => key.id === entry.keyId)?.time)
      .find((value) => value !== undefined);
    const editItems: ContextMenuItem[] = [
      { type: "separator", id: "edit-separator" },
      { id: "cut-keys", label: "Cut", icon: <ScissorsIcon />, testId: "timeline-key-menu-cut", onSelect: () => { copyKeys(targets); deleteKeys(targets); } },
      { id: "copy-keys", label: "Copy", icon: <CopyIcon />, shortcut: keybinds.get("edit.copy")?.[0], testId: "timeline-key-menu-copy", onSelect: () => copyKeys(targets) },
      { id: "paste-keys", label: "Paste", icon: <ClipboardPasteIcon />, shortcut: keybinds.get("edit.paste")?.[0],
        disabled: !session.readCopiedTimelineKeys(), testId: "timeline-key-menu-paste", onSelect: pasteKeys },
      { id: "duplicate-keys", label: "Duplicate", icon: <CopyPlusIcon />, shortcut: keybinds.get("edit.duplicate")?.[0],
        testId: "timeline-key-menu-duplicate", onSelect: () => duplicateKeys(targets) },
    ];
    // Event keys have no interpolation; Copy and Paste carry them with property keys.
    if (targets.every((entry) => findTimelineEventTrack(clip, entry.trackId))) {
      return [
        ...(touch ? [{ id: "select-key", label: "Select", icon: <MousePointerClickIcon />, testId: "timeline-key-menu-select",
          onSelect: () => selectKeys([ref], "add") } satisfies ContextMenuItem] : []),
        { id: "go-to-key", label: "Go To Key", icon: <CrosshairIcon />, disabled: keyTime === undefined, testId: "timeline-key-menu-go",
          onSelect: () => { if (keyTime !== undefined) playhead.set(keyTime); } },
        ...editItems,
        { type: "separator", id: "delete-separator" },
        { id: "delete-keys", label: "Delete", icon: <Trash2Icon />, variant: "destructive", shortcut: keybinds.get("edit.delete")?.[0],
          testId: "timeline-key-menu-delete", onSelect: () => deleteKeys(targets) },
      ];
    }
    return [
      ...(touch ? [{ id: "select-key", label: "Select", icon: <MousePointerClickIcon />, testId: "timeline-key-menu-select",
        onSelect: () => selectKeys([ref], "add") } satisfies ContextMenuItem] : []),
      { id: "go-to-key", label: "Go To Key", icon: <CrosshairIcon />, disabled: keyTime === undefined, testId: "timeline-key-menu-go",
        onSelect: () => { if (keyTime !== undefined) playhead.set(keyTime); } },
      { type: "submenu", id: "interpolation", label: "Interpolation", icon: <SplineIcon />, testId: "timeline-key-menu-interpolation", items: [
        ...(["constant", "linear", "auto"] as const).map((value) => ({ id: `interp-${value}`, label: timelineInterpolationLabel(value),
          testId: `timeline-key-menu-interp-${value}`, onSelect: () => setInterpolation(value) })),
        ...TIMELINE_EASE_SHORTCUTS.map((entry) => ({ id: `interp-${entry.value}`, label: entry.label,
          testId: `timeline-key-menu-interp-${entry.value}`, onSelect: () => setInterpolation(entry.value) })),
        { type: "submenu", id: "more-curves", label: "More Curves", items: TIMELINE_EASING_CURVES.map((curve) => ({
          id: `curve-${curve}`, label: timelineInterpolationLabel(curve), testId: `timeline-key-menu-curve-${curve}`,
          onSelect: () => setInterpolation(curve) })) },
      ] },
      ...editItems,
      { type: "separator", id: "delete-separator" },
      { id: "delete-keys", label: "Delete", icon: <Trash2Icon />, variant: "destructive", shortcut: keybinds.get("edit.delete")?.[0],
        testId: "timeline-key-menu-delete", onSelect: () => deleteKeys(targets) },
    ];
  };

  const parentOf = property.parentOf;
  const laneRows: KeyframeTimelineTrackRow[] = rows.map((row) => {
    if (row.id === TIMELINE_EVENTS_ROW_ID) {
      return {
        id: row.id, kind: "group", depth: 0, label: row.label, icon: <ZapIcon />, expanded: row.expanded, keys: row.keys,
        testId: `timeline-row-${row.id}`,
        actions: <IconActionButton label="Add Custom Event Track" variant="ghost" size={touch ? "touch-icon" : "icon-xs"}
          onClick={(event) => { event.stopPropagation(); addEventTrack(); }} data-testid="timeline-add-event-track-row">
          <PlusIcon />
        </IconActionButton>,
      };
    }
    if (row.eventTrack) {
      const keyed = Boolean(timelineEventKeyAt(row.eventTrack, time, clip.frameRate));
      return {
        id: row.id, kind: "track", depth: 1, label: row.label, value: row.value, keys: row.keys, testId: `timeline-row-${row.id}`,
        actions: <IconActionButton label={keyed ? `Remove Key on ${row.label}` : `Set Key on ${row.label}`}
          variant="ghost" size={touch ? "touch-icon" : "icon-xs"}
          onClick={(event) => { event.stopPropagation(); toggleKey(row.id); }} data-testid={`timeline-key-toggle-${row.id}`}>
          <DiamondIcon className={keyed ? "fill-current text-selection" : undefined} />
        </IconActionButton>,
      };
    }
    if (row.kind === "group") {
      return {
        id: row.id,
        kind: "group",
        depth: 0,
        label: problemLabel(row),
        icon: row.actor
          ? <TypeVisualIcon visual={resolveActorTypeVisual({ classId: row.actor.classId, components: row.actor.components, ancestry: walkAncestry(row.actor.classId, parentOf) })} />
          : <BoxIcon />,
        ...(row.value ? { value: row.value } : {}),
        expanded: row.expanded,
        keys: row.keys,
        muted: row.muted,
        testId: `timeline-row-${row.id}`,
        actions: row.actor ? <IconActionButton label={`Add Track to ${row.label}`} variant="ghost" size={touch ? "touch-icon" : "icon-xs"}
          onClick={(event) => { event.stopPropagation(); setAddTrackActorId(row.actor!.id); }} data-testid={`timeline-add-track-${row.id}`}>
          <PlusIcon />
        </IconActionButton> : undefined,
      };
    }
    const keyed = row.track ? Boolean(timelineKeyAt(row.track, time, clip.frameRate)) : false;
    const pending = unkeyed.has(row.id);
    return {
      id: row.id,
      kind: "track",
      depth: 1,
      label: problemLabel(row),
      ...(row.problem ? { icon: <TriangleAlertIcon className="text-destructive" /> } : {}),
      value: row.value,
      keys: row.keys,
      connect: row.connect,
      ...(row.gradient ? { gradient: row.gradient } : {}),
      muted: row.muted,
      testId: `timeline-row-${row.id}`,
      actions: <IconActionButton label={pending ? `Key Change on ${row.label}` : keyed ? `Remove Key on ${row.label}` : `Set Key on ${row.label}`}
        variant="ghost" size={touch ? "touch-icon" : "icon-xs"} data-unkeyed={pending ? "true" : undefined}
        onClick={(event) => { event.stopPropagation(); toggleKey(row.id); }} data-testid={`timeline-key-toggle-${row.id}`}>
        <DiamondIcon className={pending ? "fill-current text-brand-amber" : keyed ? "fill-current text-selection" : undefined} />
      </IconActionButton>,
    };
  });

  const unanimated = scene.actors.filter((actor) => !clip.objects.some((object) => object.actorId === actor.id));
  // A clip asset's rows are its proxies; only Custom Event Tracks are added here.
  const trackMenu: NestedMenuItem[] = proxies ? [
    { id: "add-event-track", label: "Custom Event Track", icon: <ZapIcon />, testId: "timeline-track-menu-event", onSelect: addEventTrack },
  ] : [
    { id: "add-selected", label: selectedActors.length === 1
        ? `Selected Actor (${actorNames.get(selectedActors[0]!) ?? "Actor"})`
        : `Selected Actors (${selectedActors.length})`,
      icon: <BoxIcon />, disabled: selectedActors.length === 0, shortcut: keybinds.get("timeline.addSelectedActors")?.[0],
      testId: "timeline-track-menu-selected", onSelect: () => addActors(selectedActors) },
    { id: "add-actor", label: "Actor From Outliner…", icon: <PlusIcon />, disabled: unanimated.length === 0, testId: "timeline-track-menu-actor",
      onSelect: () => setPickActorOpen(true) },
    { type: "separator", id: "event-separator" },
    { id: "add-event-track", label: "Custom Event Track", icon: <ZapIcon />, testId: "timeline-track-menu-event", onSelect: addEventTrack },
  ];

  const addTrackActor = addTrackActorId ? scene.actors.find((actor) => actor.id === addTrackActorId) : undefined;
  const addTrackGroups = useMemo((): ChecklistDialogGroup[] => {
    if (!addTrackActor) return [];
    const present = new Set(clip.objects.find((object) => object.actorId === addTrackActor.id)?.tracks.map((track) => timelineTargetKey(track.target)));
    return timelinePropertyGroups(addTrackActor, contextFor(addTrackActor)).map((group) => ({
      id: group.id,
      label: group.label,
      items: group.entries.map((entry) => {
        const key = timelineTargetKey(entry.target);
        return {
          id: key,
          label: entry.label,
          included: present.has(key),
          keywords: group.label,
          trailing: <TypeColorMark colorVar={pinPickerColorVar(entry.valueType)} label={pinPickerLabel(entry.valueType)} />,
          testId: `timeline-add-track-item-${key}`,
        };
      }),
    }));
  }, [addTrackActor, clip.objects, contextFor]);
  const confirmAddTracks = (keys: string[]) => {
    if (!addTrackActor) return;
    const wanted = new Set(keys);
    const entries = timelinePropertyGroups(addTrackActor, contextFor(addTrackActor))
      .flatMap((group) => group.entries)
      .filter((entry) => wanted.has(timelineTargetKey(entry.target)));
    commitClip(addTimelineTracks(clip, addTrackActor.id, entries, newId));
    // Open the object so its new tracks show.
    const object = clip.objects.find((entry) => entry.actorId === addTrackActor.id);
    if (object && collapsed.has(object.id)) setCollapsed((current) => new Set([...current].filter((id) => id !== object.id)));
  };

  const frameRateItems = TIMELINE_FRAME_RATES.map((rate) => ({ value: String(rate), label: `${rate} fps` }));
  const rowHeight = touch ? 44 : 24;
  const setTime = (next: number) => playhead.set(Math.min(clip.length, Math.max(0, next)));

  return <PanelFrame>
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col" data-testid="scene-timeline-panel">
      <ToolbarStrip data-testid="scene-timeline-toolbar">
        <span className="max-w-28 truncate px-1 font-medium" data-testid="scene-timeline-title">{clip.name}</span>
        <TransportButton label="Go to Start" onClick={() => setTime(0)} testId="timeline-go-start"><SkipBackIcon /></TransportButton>
        <TransportButton label="Previous Key" shortcut={keybinds.get("timeline.previousKey")?.[0]} onClick={() => jumpToKey(-1)} testId="timeline-previous-key"><StepBackIcon /></TransportButton>
        <TransportButton label={playing ? "Pause" : "Play"} onClick={() => setPlaying((value) => !value)} testId="timeline-play">
          {playing ? <PauseIcon /> : <PlayIcon />}
        </TransportButton>
        <TransportButton label="Next Key" shortcut={keybinds.get("timeline.nextKey")?.[0]} onClick={() => jumpToKey(1)} testId="timeline-next-key"><StepForwardIcon /></TransportButton>
        <TransportButton label="Go to End" onClick={() => setTime(clip.length)} testId="timeline-go-end"><SkipForwardIcon /></TransportButton>
        <Toggle size="sm" aria-label="Loop Preview" pressed={looping} onPressedChange={setLooping} data-testid="timeline-loop"><RepeatIcon /></Toggle>
        <NumberField className="h-7 w-16 text-xs" aria-label="Playhead Time" unit="s" min={0} max={clip.length}
          value={Number(time.toFixed(2))} onChange={setTime} data-testid="timeline-time" />
        <span className="text-muted-foreground">of</span>
        <NumberField className="h-7 w-16 text-xs" aria-label="Clip Length" unit="s" min={MIN_TIMELINE_CLIP_LENGTH}
          value={clip.length} onChange={(length) => commitClip({ ...clip, length: Math.max(MIN_TIMELINE_CLIP_LENGTH, length) })} data-testid="timeline-length" />
        <Select value={String(clip.frameRate)} onValueChange={(value) => commitClip({ ...clip, frameRate: Number(value) as TimelineFrameRate })}>
          <SelectTrigger size="sm" aria-label="Frame Rate" className="w-22" data-testid="timeline-frame-rate"><SelectValue>{`${clip.frameRate} fps`}</SelectValue></SelectTrigger>
          <SelectContent>{frameRateItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <Toggle size="sm" aria-label="Snap to Frames" pressed={snap} onPressedChange={setSnap} data-testid="timeline-snap"><MagnetIcon /></Toggle>
        <Toggle size="sm" aria-label="Auto Key" pressed={autoKey} onPressedChange={setAutoKey} data-testid="timeline-auto-key">
          <CircleDotIcon className={autoKey ? "text-destructive" : undefined} />Auto Key
        </Toggle>
        <TransportButton label="Zoom To Fit" onClick={() => setFitToken((token) => token + 1)} testId="timeline-zoom-fit"><UnfoldHorizontalIcon /></TransportButton>
        <ToggleGroup variant="outline" size="sm" spacing={0} value={[view]} aria-label="Timeline View"
          onValueChange={(values) => { if (values[0] === "keys" || values[0] === "curves") setView(values[0]); }}>
          <ToggleGroupItem value="keys" data-testid="timeline-view-keys">Keys</ToggleGroupItem>
          <ToggleGroupItem value="curves" data-testid="timeline-view-curves">Curves</ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1" />
        <NestedMenu items={trackMenu} trigger={<Button variant="ghost" size="sm" data-testid="timeline-add-menu">
          <PlusIcon data-icon="inline-start" />Track<ChevronDownIcon data-icon="inline-end" />
        </Button>} />
      </ToolbarStrip>
      {clip.objects.length === 0 ? (
        <Empty className="min-h-0 flex-1 gap-3 p-4" data-testid="scene-timeline-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FilmIcon /></EmptyMedia>
            <EmptyTitle>No Tracks</EmptyTitle>
            <EmptyDescription>Drag an actor here from the Outliner, or use Track to add the selected actors.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : view === "curves" ? (
        <TimelineCurves clip={clip} rows={rows} rowId={rowId} setRowId={setRowId} snap={snap} commitClip={commitClip} touch={touch} />
      ) : (
        <KeyframeTimeline
          rows={laneRows}
          length={clip.length}
          frameRate={clip.frameRate}
          time={time}
          onTimeChange={(next) => playhead.set(next)}
          snap={snap}
          selectedKeys={laneSelection(clip, selection)}
          onSelectKeys={selectKeys}
          onMoveKeys={moveKeys}
          selectedRowId={rowId}
          onSelectRow={setRowId}
          onToggleRow={(id) => setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })}
          onRowContextMenu={(id, x, y) => {
            const row = rowById.get(id);
            if (row) openMenuAt(x, y, rowMenuItems(row));
          }}
          onKeyContextMenu={(ref, x, y) => openMenuAt(x, y, keyMenuItems(ref))}
          onLengthChange={(length, phase) => {
            // One undo step: every move replaces the clip at the drag's start length.
            if (phase === "start") lengthDrag.current = clip.length;
            const next = phase === "cancel" ? lengthDrag.current ?? clip.length : Math.max(MIN_TIMELINE_CLIP_LENGTH, length);
            if (next !== clip.length) commitClip({ ...clip, length: next });
            if (phase === "end" || phase === "cancel") lengthDrag.current = null;
          }}
          fitToken={fitToken}
          header={<SearchInput value={filter} onChange={setFilter} placeholder="Filter Tracks" aria-label="Filter Tracks" className="h-6 text-xs" />}
          rowHeight={rowHeight}
          aria-label={`${clip.name} Keys`}
          data-testid="scene-timeline-keys"
        />
      )}
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <ChecklistDialog
        open={Boolean(addTrackActor)}
        onOpenChange={(open) => { if (!open) setAddTrackActorId(null); }}
        title={`Add Track to ${addTrackActor ? actorName(addTrackActor) : "Actor"}`}
        description="Pick one or more properties. Properties already on this clip are checked."
        groups={addTrackGroups}
        confirmLabel="Add Tracks"
        onConfirm={confirmAddTracks}
        searchPlaceholder="Search Properties"
        emptyLabel="No Matching Properties"
        data-testid="timeline-add-track-dialog"
      />
      <ChecklistDialog
        open={pickActorOpen}
        onOpenChange={setPickActorOpen}
        title={`Add Actors to ${clip.name}`}
        description="Pick the actors this clip animates. Actors already in it are checked."
        groups={[{ id: "actors", label: "Actors", items: scene.actors.map((actor) => ({
          id: actor.id,
          label: actorNames.get(actor.id) ?? actor.name,
          included: clip.objects.some((object) => object.actorId === actor.id),
          testId: `timeline-pick-actor-${actor.id}`,
        })) }]}
        confirmLabel="Add Actors"
        onConfirm={addActors}
        searchPlaceholder="Search Actors"
        emptyLabel="No Matching Actors"
        data-testid="timeline-pick-actor"
      />
    </div>
  </PanelFrame>;
}

/** Curves view: the clip's interpolated tracks beside the curve editor for the selected one. */
function TimelineCurves({ clip, rows, rowId, setRowId, snap, commitClip, touch }: {
  clip: SerializedTimelineClip;
  rows: readonly TimelineRowModel[];
  rowId: string | null;
  setRowId: (id: string | null) => void;
  snap: boolean;
  commitClip: (clip: SerializedTimelineClip) => void;
  touch: boolean;
}) {
  const tracks = rows.filter((row) => row.kind === "track" && row.track && timelineCurveKind(row.track.valueType));
  const groups = new Map(rows.filter((row) => row.kind === "group").map((row) => [row.id, row.label]));
  const selected = tracks.find((row) => row.id === rowId) ?? null;
  const track = selected?.track;
  const kind = track ? timelineCurveKind(track.valueType) : null;
  return <div className="flex min-h-0 flex-1" data-testid="timeline-curves">
    <div className="w-[264px] shrink-0 border-r">
      {tracks.length ? <TreeView
        aria-label="Curve Tracks"
        rowHeight={touch ? 44 : undefined}
        nodes={tracks.map((row) => ({
          id: row.id,
          label: `${groups.get(row.objectId) ?? "Actor"} › ${row.label}`,
          depth: 0,
          hasChildren: false,
          expanded: false,
          draggable: false,
          muted: row.muted,
        }))}
        selectedId={selected?.id ?? null}
        onSelect={(id) => setRowId(id)}
        data-testid="timeline-curve-tracks"
      /> : <p className="p-3 text-xs text-muted-foreground">Add a Float, Vector, Rotator or Color track to edit its curves.</p>}
    </div>
    <div className="min-w-0 flex-1 overflow-y-auto p-2">
      {track && kind ? (
        <CurveEditor
          key={track.id}
          kind={kind}
          aria-label={selected!.label}
          value={timelineTrackCurve(track)}
          channels={timelineCurveChannels(track.valueType)}
          constraints={{
            timeRange: [0, clip.length],
            ...(snap ? { timeSnap: 1 / clip.frameRate } : {}),
            keyGap: 0.5 / clip.frameRate,
            extrapolation: "constant",
            sharedKeys: true,
          }}
          onChange={(curve) => commitClip({
            ...clip,
            objects: clip.objects.map((object) => ({
              ...object,
              tracks: object.tracks.map((entry) => (entry.id === track.id ? applyTimelineCurve(entry, curve, newId) : entry)),
            })),
          })}
          data-testid="timeline-curve"
        />
      ) : tracks.length ? <p className="p-3 text-xs text-muted-foreground">Pick a track to edit its curves.</p> : null}
    </div>
  </div>;
}


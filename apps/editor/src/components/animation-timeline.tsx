import { useRef, useState, useSyncExternalStore } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  KeyframeTimeline,
  PanelFrame,
  ToolbarStrip,
  keyRefFromId,
  keyRefId,
  type GesturePhase,
  type KeyRef,
  type KeySelectMode,
  type KeyframeTimelineTrackRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { PlusIcon } from "lucide-react";
import {
  DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT,
  nextAnimationEventId,
  normalizeAnimationPayload,
  type AnimationEventPayload,
  type AnimationPayload,
} from "@haptic/assets";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalAnimationEditing } from "../context/animation-editing-context";
import type { AnimationPreviewClock } from "../lib/animation-preview-clock";
import { asRecord } from "../lib/as-record";
import { BEGIN, END, EVENTS_ROW, eventOfKey, moveAnimationEvents, windowRowId } from "../lib/animation-event-timeline";

/** The Timeline snaps to this many frames a second, as the Preview steps. */
const TIMELINE_FRAME_RATE = 30;
/** A new window spans this share of the clip. */
const NEW_WINDOW_SHARE = 0.2;

function timelineRows(events: readonly AnimationEventPayload[]): KeyframeTimelineTrackRow[] {
  const singles = events.filter((event) => !(event.durationMs > 0));
  const windows = events.filter((event) => event.durationMs > 0);
  return [
    {
      id: EVENTS_ROW,
      kind: "track",
      label: "Events",
      depth: 0,
      keys: singles.map((event) => ({ id: event.id, time: event.timeMs / 1000, shape: "diamond", label: event.name || "Event" })),
      testId: "animation-timeline-events",
    },
    ...windows.map((event): KeyframeTimelineTrackRow => ({
      id: windowRowId(event.id),
      kind: "track",
      label: event.name || "Window",
      depth: 0,
      connect: true,
      keys: [
        { id: `${event.id}${BEGIN}`, time: event.timeMs / 1000, shape: "square", label: event.name || "Window" },
        { id: `${event.id}${END}`, time: (event.timeMs + event.durationMs) / 1000, shape: "square" },
      ],
      testId: `animation-timeline-window-${event.id}`,
    })),
  ];
}

/**
 * An Animation's Animation Events on a timeline under the Preview: single events on the Events row, each window on a
 * row of its own from its begin to its end. Scrubbing the ruler moves the Preview's playhead; Add Event and Add Window
 * place a new one there. Drag keys to move them (a window's end alone changes its Duration); selected keys open their
 * events in the Inspector.
 */
export function AnimationEventTimeline({
  animation,
  clock,
  selectedEventIds,
  onSelectEvents,
  onChange,
}: {
  animation: AnimationPayload;
  clock: AnimationPreviewClock;
  selectedEventIds: ReadonlySet<string>;
  onSelectEvents: (ids: ReadonlySet<string>) => void;
  onChange: (events: AnimationEventPayload[], mergeKey?: string) => void;
}) {
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const lengthMs = animation.durationMs ?? animation.clipDurationMs ?? 1000;
  const events = animation.events ?? [];
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Keys whose event is no longer selected (picked in the Inspector, or removed) drop out.
  const shownKeys = new Set([...selectedKeys].filter((id) => selectedEventIds.has(eventOfKey(keyRefFromId(id)).id)));
  const drag = useRef<{ base: AnimationEventPayload[]; key: string } | null>(null);
  const select = (ids: ReadonlySet<string>) => {
    setSelectedKeys(ids);
    onSelectEvents(new Set([...ids].map((id) => eventOfKey(keyRefFromId(id)).id)));
  };
  const add = (window: boolean) => {
    const id = nextAnimationEventId(events);
    const at = Math.min(lengthMs, Math.max(0, Math.round(timeMs)));
    const durationMs = window ? Math.max(1, Math.round(Math.min(lengthMs - at, lengthMs * NEW_WINDOW_SHARE))) : 0;
    const event: AnimationEventPayload = {
      id,
      name: window ? "Window" : "Event",
      timeMs: window && durationMs <= 1 ? Math.max(0, at - 1) : at,
      durationMs,
      triggerWeight: DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT,
      action: null,
    };
    onChange([...events, event]);
    select(new Set(window
      ? [keyRefId({ rowId: windowRowId(id), keyId: `${id}${BEGIN}` }), keyRefId({ rowId: windowRowId(id), keyId: `${id}${END}` })]
      : [keyRefId({ rowId: EVENTS_ROW, keyId: id })]));
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="animation-timeline">
      <ToolbarStrip className="shrink-0 gap-1 py-1">
        <Button type="button" variant="outline" size="sm" data-testid="animation-timeline-add-event" onClick={() => add(false)}>
          <PlusIcon data-icon="inline-start" aria-hidden />
          Add Event
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="animation-timeline-add-window" onClick={() => add(true)}>
          <PlusIcon data-icon="inline-start" aria-hidden />
          Add Window
        </Button>
      </ToolbarStrip>
      <KeyframeTimeline
        className="min-h-0 flex-1"
        rows={timelineRows(events)}
        length={lengthMs / 1000}
        frameRate={TIMELINE_FRAME_RATE}
        snap
        time={timeMs / 1000}
        onTimeChange={(time) => clock.seek(time * 1000)}
        selectedKeys={shownKeys}
        onSelectKeys={(refs: KeyRef[], mode: KeySelectMode) => {
          const ids = refs.map(keyRefId);
          if (mode === "replace") select(new Set(ids));
          else if (mode === "add") select(new Set([...shownKeys, ...ids]));
          else {
            const next = new Set(shownKeys);
            for (const id of ids) {
              if (next.has(id)) next.delete(id);
              else next.add(id);
            }
            select(next);
          }
        }}
        onMoveKeys={(deltaSeconds: number, phase: GesturePhase) => {
          if (phase === "start") {
            drag.current = { base: events, key: `animation:event:move:${Date.now()}` };
            return;
          }
          const gesture = drag.current;
          if (!gesture) return;
          if (phase === "cancel") {
            onChange(gesture.base, gesture.key);
            drag.current = null;
            return;
          }
          onChange(moveAnimationEvents(gesture.base, [...shownKeys].map(keyRefFromId), deltaSeconds * 1000, lengthMs), gesture.key);
          if (phase === "end") drag.current = null;
        }}
        aria-label="Animation Events"
        data-testid="animation-timeline-keys"
      />
    </div>
  );
}

export function AnimationTimelinePanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const editing = useOptionalAnimationEditing();
  const payload = asRecord(doc?.content);
  const animation = normalizeAnimationPayload(payload);
  return (
    <PanelFrame data-testid="animation-timeline-panel">
      {editing ? (
        <AnimationEventTimeline
          animation={animation}
          clock={editing.clock}
          selectedEventIds={editing.selectedEventIds}
          onSelectEvents={editing.setSelectedEventIds}
          onChange={(events, mergeKey) => {
            void applyAssetDocumentChange(documentId, { ...payload, ...animation, events }, mergeKey);
          }}
        />
      ) : null}
    </PanelFrame>
  );
}

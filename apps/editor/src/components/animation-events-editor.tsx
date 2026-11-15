import { useState } from "react";
import {
  AssetPicker,
  ModuleCard,
  ModuleStage,
  PropertyGrid,
  assetRowIdentity,
  type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { PlusIcon, Trash2Icon } from "lucide-react";
import {
  DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT,
  nextAnimationEventId,
  type AnimationEventAction,
  type AnimationEventActionKind,
} from "@haptic/assets";
import { useRegistryState } from "../context/document-context";

/** An event the section edits: an Animation's (with a time and a window length) or a Sprite Animation frame's. */
export interface EditableAnimationEvent {
  id: string;
  name: string;
  triggerWeight: number;
  action: AnimationEventAction | null;
  timeMs?: number;
  durationMs?: number;
}

const ACTION_OPTIONS: Array<{ value: AnimationEventActionKind | "none"; label: string }> = [
  { value: "none", label: "None" },
  { value: "playSound", label: "Play Sound" },
  { value: "spawnParticles", label: "Spawn Particle System" },
];

function emptyAction(kind: AnimationEventActionKind | "none"): AnimationEventAction | null {
  if (kind === "playSound") return { kind, assetGuid: "", volume: 1 };
  if (kind === "spawnParticles") return { kind, assetGuid: "", bone: "" };
  return null;
}

function eventSummary(event: EditableAnimationEvent): string {
  if (event.timeMs === undefined) return event.action ? ACTION_OPTIONS.find((option) => option.value === event.action!.kind)!.label : "";
  const at = `${Math.round(event.timeMs)} ms`;
  return event.durationMs && event.durationMs > 0 ? `${at} · ${Math.round(event.durationMs)} ms` : at;
}

/**
 * An asset's or frame's Animation Events, one card each: Name, Time and Duration (an Animation's: Duration above 0
 * makes a window), Trigger Weight, and an optional built-in Action. `timed` adds the time rows; `bones` the Bone row
 * of Spawn Particle System. Edits go through `onChange`, with a merge key per field so a scrub is one undo step.
 */
export function AnimationEventsEditor({
  events,
  timed,
  bones,
  newEventTimeMs = 0,
  selectedIds,
  onChange,
  mergeKeyPrefix,
  "data-testid": testId,
}: {
  events: readonly EditableAnimationEvent[];
  timed: boolean;
  bones: boolean;
  /** Where Add Event places a new event (an Animation's). */
  newEventTimeMs?: number;
  /** Events selected elsewhere (the Timeline): their cards open and are marked. */
  selectedIds?: ReadonlySet<string>;
  onChange?: (events: EditableAnimationEvent[], mergeKey?: string) => void;
  mergeKeyPrefix: string;
  "data-testid"?: string;
}) {
  const { assetRegistry } = useRegistryState();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [pick, setPick] = useState<{ eventId: string; assetType: "Audio" | "ParticleSystem" } | null>(null);
  const disabled = !onChange;
  const patch = (id: string, change: Partial<EditableAnimationEvent>, field?: string) =>
    onChange?.(
      events.map((event) => (event.id === id ? { ...event, ...change } : event)),
      field ? `${mergeKeyPrefix}:${id}:${field}` : undefined,
    );
  const patchAction = (event: EditableAnimationEvent, change: Partial<AnimationEventAction>, field?: string) => {
    if (!event.action) return;
    patch(event.id, { action: { ...event.action, ...change } as AnimationEventAction }, field);
  };
  const assetIdentity = (guid: string, type: string) => {
    const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
    return assetRowIdentity(asset ? { name: asset.header.name, type: asset.header.type } : guid ? { name: guid, type } : undefined);
  };
  const rowsFor = (event: EditableAnimationEvent): PropertyRow[] => {
    const rows: PropertyRow[] = [
      { id: `${event.id}-name`, kind: "text", label: "Name", value: event.name, disabled, onChange: (name) => patch(event.id, { name }, "name") },
    ];
    if (timed) {
      rows.push(
        {
          id: `${event.id}-time`,
          kind: "number",
          label: "Time",
          unit: "ms",
          min: 0,
          value: event.timeMs ?? 0,
          disabled,
          onChange: (timeMs) => patch(event.id, { timeMs: Math.max(0, timeMs) }, "time"),
        },
        {
          id: `${event.id}-duration`,
          kind: "number",
          label: "Duration",
          unit: "ms",
          min: 0,
          value: event.durationMs ?? 0,
          defaultValue: 0,
          description: "Above 0, the event is a window with a Begin and an End.",
          disabled,
          onChange: (durationMs) => patch(event.id, { durationMs: Math.max(0, durationMs) }, "duration"),
        },
      );
    }
    rows.push(
      {
        id: `${event.id}-trigger-weight`,
        kind: "number",
        label: "Trigger Weight",
        min: 0,
        max: 1,
        value: event.triggerWeight,
        defaultValue: DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT,
        description: "The weight the animation must play at for the event to fire, so a fading-out clip does not fire it.",
        disabled,
        onChange: (triggerWeight) => patch(event.id, { triggerWeight: Math.min(1, Math.max(0, triggerWeight)) }, "trigger-weight"),
      },
      {
        id: `${event.id}-action`,
        kind: "enum",
        label: "Action",
        value: event.action?.kind ?? "none",
        options: ACTION_OPTIONS,
        disabled,
        onChange: (kind) => patch(event.id, { action: emptyAction(kind as AnimationEventActionKind | "none") }),
      },
    );
    const action = event.action;
    if (action?.kind === "playSound") {
      rows.push(
        {
          id: `${event.id}-sound`,
          kind: "asset",
          label: "Sound",
          value: action.assetGuid || null,
          placeholder: "None",
          assetTypes: ["Audio"],
          disabled,
          onPick: () => setPick({ eventId: event.id, assetType: "Audio" }),
          onChange: (guid) => patchAction(event, { assetGuid: guid ?? "" }),
          ...assetIdentity(action.assetGuid, "Audio"),
        },
        {
          id: `${event.id}-volume`,
          kind: "number",
          label: "Volume",
          min: 0,
          value: action.volume,
          defaultValue: 1,
          disabled,
          onChange: (volume) => patchAction(event, { volume: Math.max(0, volume) }, "volume"),
        },
      );
    } else if (action?.kind === "spawnParticles") {
      rows.push({
        id: `${event.id}-particles`,
        kind: "asset",
        label: "Particle System",
        value: action.assetGuid || null,
        placeholder: "None",
        assetTypes: ["ParticleSystem"],
        disabled,
        onPick: () => setPick({ eventId: event.id, assetType: "ParticleSystem" }),
        onChange: (guid) => patchAction(event, { assetGuid: guid ?? "" }),
        ...assetIdentity(action.assetGuid, "ParticleSystem"),
      });
      if (bones) {
        rows.push({
          id: `${event.id}-bone`,
          kind: "text",
          label: "Bone",
          value: action.bone,
          description: "Spawns it at this bone, following it. Empty spawns it at the actor.",
          disabled,
          onChange: (bone) => patchAction(event, { bone }, "bone"),
        });
      }
    }
    return rows;
  };
  const pickEvent = pick ? events.find((event) => event.id === pick.eventId) : undefined;
  const pickerAssets = pick
    ? (assetRegistry?.list() ?? [])
        .filter((asset) => asset.header.type === pick.assetType)
        .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))
    : [];
  return (
    <ModuleStage id={`${mergeKeyPrefix}-events`} title="Events" accentRole="flow">
      <div data-testid={testId} className="flex flex-col gap-1">
        {events.map((event) => (
          <div
            key={event.id}
            data-selected={selectedIds?.has(event.id) ? "true" : undefined}
            className="rounded-md data-[selected=true]:ring-1 data-[selected=true]:ring-primary"
          >
          <ModuleCard
            id={event.id}
            title={event.name || "Unnamed Event"}
            summary={eventSummary(event)}
            open={selectedIds?.has(event.id) === true || !collapsed.has(event.id)}
            onOpenChange={(open) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (open) next.delete(event.id);
                else next.add(event.id);
                return next;
              })
            }
            data-testid={testId ? `${testId}-event-${event.id}` : undefined}
          >
            <PropertyGrid rows={rowsFor(event)} />
            <div className="flex px-2 py-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                data-testid={testId ? `${testId}-remove-${event.id}` : undefined}
                onClick={() => onChange?.(events.filter((row) => row.id !== event.id))}
              >
                <Trash2Icon data-icon="inline-start" aria-hidden />
                Remove Event
              </Button>
            </div>
          </ModuleCard>
          </div>
        ))}
        <div className="flex py-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            data-testid={testId ? `${testId}-add` : undefined}
            onClick={() =>
              onChange?.([
                ...events,
                {
                  id: nextAnimationEventId(events),
                  name: "Event",
                  triggerWeight: DEFAULT_ANIMATION_EVENT_TRIGGER_WEIGHT,
                  action: null,
                  ...(timed ? { timeMs: Math.max(0, Math.round(newEventTimeMs)), durationMs: 0 } : {}),
                },
              ])
            }
          >
            <PlusIcon data-icon="inline-start" aria-hidden />
            Add Event
          </Button>
        </div>
      </div>
      <AssetPicker
        open={pick !== null}
        onOpenChange={(open) => {
          if (!open) setPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={pick ? [pick.assetType] : undefined}
        title={pick?.assetType === "Audio" ? "Pick Sound" : "Pick Particle System"}
        allowNone
        onPick={(guid) => {
          if (pickEvent) patchAction(pickEvent, { assetGuid: guid ?? "" });
          setPick(null);
        }}
        data-testid={testId ? `${testId}-asset-picker` : undefined}
      />
    </ModuleStage>
  );
}

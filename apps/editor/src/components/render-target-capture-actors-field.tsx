import { useState } from "react";
import { EntryListEditor, PropertyGrid, SearchDialog, humanizePropertyLabel } from "@babylonslate/editor-kit";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import type { SerializedActor } from "@babylonslate/core";

/** Scene Actor references share one picker/list in scene and prefab Details. */
export function RenderTargetCaptureActorsField({ actorIds, actors, onChange }: {
  actorIds: readonly string[];
  actors: readonly SerializedActor[];
  onChange: (actorIds: string[]) => void;
}) {
  const [picking, setPicking] = useState<number | null>(null);
  return <Field className="p-2" data-testid="capture-actors-field">
    <FieldLabel>Capture Actors</FieldLabel>
    <EntryListEditor items={actorIds} onChange={onChange} onAdd={() => setPicking(actorIds.length)} addLabel="Add Actor" countNoun={{ one: "actor", other: "actors" }}
      renderItem={({ item: actorId, index, onChange: update }) => {
        const actor = actors.find((entry) => entry.id === actorId);
        return <PropertyGrid density="compact" hideLabels rows={[{
          id: `capture-actor-${index}`, kind: "asset", label: `Capture Actor ${index + 1}`, value: actorId,
          displayLabel: actor?.name || actorId, displayType: actor ? humanizePropertyLabel(actor.classId) : "Missing Actor",
          visual: { classId: actor?.classId ?? "Actor", family: "class" },
          onPick: () => setPicking(index), onChange: (value) => update(value ?? ""),
        }]} />;
      }} />
    <SearchDialog open={picking !== null} onOpenChange={(open) => { if (!open) setPicking(null); }} title="Pick Capture Actor" placeholder="Search Actors" emptyLabel="No Matching Actors"
      items={actors.filter((actor) => !actorIds.includes(actor.id) || actor.id === actorIds[picking ?? -1]).map((actor) => ({ id: actor.id, label: actor.name, description: humanizePropertyLabel(actor.classId), visual: { classId: actor.classId, family: "class" as const } }))}
      onSelect={(actorId) => { if (picking === null) return; const next = [...actorIds]; next[picking] = actorId; onChange(next); setPicking(null); }}
      data-testid="capture-actors-picker" />
  </Field>;
}

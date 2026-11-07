import { useMemo } from "react";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";

export interface SceneActorPickerEntry {
  actorId: string;
  actorName: string;
  classId: string;
  /** Section the row is listed under; rows keep the order they are given. Missing is "Actors". */
  group?: string;
}

export interface SceneActorPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actors: readonly SceneActorPickerEntry[];
  onPick: (actorId: string | null) => void;
  title?: string;
  allowNone?: boolean;
  "data-testid"?: string;
}

const NONE_ID = "__none__";

/** Picker of the actors placed in the open scene, built on the shared search dialog. */
export function SceneActorPicker({
  open,
  onOpenChange,
  actors,
  onPick,
  title = "Pick Actor",
  allowNone = true,
  "data-testid": testId,
}: SceneActorPickerProps) {
  const items = useMemo<SearchDialogItem[]>(() => {
    const rows: SearchDialogItem[] = actors.map((entry) => ({
      id: entry.actorId,
      label: entry.actorName,
      description: entry.classId,
      group: entry.group ?? "Actors",
      leading: <TypeVisualIcon visual={resolveTypeVisual({ classId: entry.classId, family: "class" })} />,
    }));
    return allowNone
      ? [{ id: NONE_ID, label: "None", description: "Clear reference" }, ...rows]
      : rows;
  }, [actors, allowNone]);

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search Actors"
      emptyLabel="No Matching Actors"
      onSelect={(id) => onPick(id === NONE_ID ? null : id)}
      data-testid={testId ?? "scene-actor-picker"}
    />
  );
}

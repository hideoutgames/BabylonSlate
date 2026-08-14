import { useMemo } from "react";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";

export interface SceneComponentPickerEntry {
  actorId: string;
  componentId: string;
  actorName: string;
  componentTitle: string;
  classId: string;
}

export interface SceneComponentRef {
  actorId: string;
  componentId: string;
}

export interface SceneComponentPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  components: SceneComponentPickerEntry[];
  /** Source-only class filter; never shown as a type dropdown. */
  allowedClassIds?: readonly string[];
  onPick: (ref: SceneComponentRef | null) => void;
  title?: string;
  allowNone?: boolean;
  "data-testid"?: string;
}

const NONE_ID = "__none__";

export function sceneComponentPickId(entry: SceneComponentPickerEntry): string {
  return `${entry.actorId}:${entry.componentId}`;
}

export function parseSceneComponentPickId(
  id: string,
): SceneComponentRef | null {
  const split = id.indexOf(":");
  if (split <= 0 || split === id.length - 1) return null;
  return {
    actorId: id.slice(0, split),
    componentId: id.slice(split + 1),
  };
}

/** Scene-component picker built on the shared search dialog. */
export function SceneComponentPicker({
  open,
  onOpenChange,
  components,
  allowedClassIds,
  onPick,
  title = "Pick Component",
  allowNone = true,
  "data-testid": testId,
}: SceneComponentPickerProps) {
  const items = useMemo<SearchDialogItem[]>(() => {
    const filtered =
      allowedClassIds && allowedClassIds.length > 0
        ? components.filter((entry) => allowedClassIds.includes(entry.classId))
        : components;
    const rows: SearchDialogItem[] = filtered.map((entry) => ({
      id: sceneComponentPickId(entry),
      label: `${entry.actorName} ${entry.componentTitle}`,
      description: entry.classId,
      group: entry.classId,
      leading: (
        <TypeVisualIcon
          visual={resolveTypeVisual({
            classId: entry.classId,
            family: "class",
          })}
        />
      ),
    }));
    return allowNone
      ? [{ id: NONE_ID, label: "None", description: "Clear reference" }, ...rows]
      : rows;
  }, [allowNone, allowedClassIds, components]);

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search components"
      emptyLabel="No matching components"
      onSelect={(id) =>
        onPick(id === NONE_ID ? null : parseSceneComponentPickId(id))
      }
      data-testid={testId ?? "scene-component-picker"}
    />
  );
}

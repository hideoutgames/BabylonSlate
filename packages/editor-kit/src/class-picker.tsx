import { useMemo } from "react";
import { SearchSheet, type SearchSheetItem } from "./search-sheet";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";

export interface ClassPickerEntry {
  id: string;
  name: string;
  description?: string;
  group?: string;
}

export interface ClassPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: ClassPickerEntry[];
  onPick: (classId: string | null) => void;
  title?: string;
  allowNone?: boolean;
  "data-testid"?: string;
}

const NONE_ID = "__none__";

/** Class id picker built on the shared search sheet. */
export function ClassPicker({
  open,
  onOpenChange,
  classes,
  onPick,
  title = "Pick Class",
  allowNone = true,
  "data-testid": testId,
}: ClassPickerProps) {
  const items = useMemo<SearchSheetItem[]>(() => {
    const rows: SearchSheetItem[] = classes.map((entry) => ({
      id: entry.id,
      label: entry.name,
      description: entry.description ?? entry.group,
      group: entry.group,
      leading: (
        <TypeVisualIcon
          visual={resolveTypeVisual({
            classId: entry.id,
            family: "class",
          })}
        />
      ),
    }));
    return allowNone
      ? [{ id: NONE_ID, label: "None", description: "Clear reference" }, ...rows]
      : rows;
  }, [allowNone, classes]);

  return (
    <SearchSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search classes"
      emptyLabel="No classes"
      onSelect={(id) => onPick(id === NONE_ID ? null : id)}
      data-testid={testId ?? "class-picker"}
    />
  );
}

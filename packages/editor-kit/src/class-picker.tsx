import { useMemo } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { displayPickerTitle } from "./picker-identity";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";
import { useAssetCreate, usePickerCreate } from "./asset-create-context";

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
  /**
   * Parent class for a "Create New Class" row, shown when an
   * AssetCreateProvider can create Classes. Omit for type or parent choosers.
   */
  createBaseClass?: string;
  "data-testid"?: string;
}

const NONE_ID = "__none__";
const CREATE_ID = "__create__Class";

/** Class id picker built on the shared search dialog. */
export function ClassPicker({
  open,
  onOpenChange,
  classes,
  onPick,
  title = "Pick Class",
  allowNone = true,
  createBaseClass,
  "data-testid": testId,
}: ClassPickerProps) {
  const api = useAssetCreate();
  const createClass = createBaseClass?.trim() ? api?.createClass : undefined;
  const { creatingId, error, run } = usePickerCreate({
    open,
    onOpenChange,
    onPick,
  });
  const items = useMemo<SearchDialogItem[]>(() => {
    const rows: SearchDialogItem[] = classes.map((entry) => ({
      id: entry.id,
      label: displayPickerTitle(entry.name),
      description: "Class",
      group: [entry.group, entry.description].filter(Boolean).join(" "),
      leading: (
        <TypeVisualIcon
          visual={resolveTypeVisual({
            classId: entry.id,
            family: "class",
          })}
        />
      ),
    }));
    const base = createBaseClass?.trim() ?? "";
    const baseName = displayPickerTitle(
      classes.find((entry) => entry.id === base)?.name ?? base,
    );
    const createRows: SearchDialogItem[] = createClass
      ? [
          {
            id: CREATE_ID,
            label: "Create New Class",
            description:
              creatingId === CREATE_ID ? "Creating…" : `Child of ${baseName}`,
            leading: (
              <TypeVisualIcon
                visual={resolveTypeVisual({
                  assetType: "Class",
                  parentClass: base,
                })}
              />
            ),
            pinned: true,
            keepOpen: true,
          },
        ]
      : [];
    return [
      ...(allowNone
        ? [{ id: NONE_ID, label: "None", description: "Clear reference" }]
        : []),
      ...createRows,
      ...rows,
    ];
  }, [allowNone, classes, createBaseClass, createClass, creatingId]);

  const select = (id: string, query: string) => {
    if (id === NONE_ID) {
      onPick(null);
      return;
    }
    if (id === CREATE_ID && createClass && createBaseClass) {
      const name = query.trim() || undefined;
      const parentClass = createBaseClass.trim();
      void run(id, () => createClass({ parentClass, name }));
      return;
    }
    onPick(id);
  };

  const pickerTestId = testId ?? "class-picker";
  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search Classes"
      emptyLabel="No Classes"
      busy={creatingId !== null}
      status={
        error ? (
          <Alert variant="destructive" data-testid={`${pickerTestId}-error`}>
            <AlertTitle>Could Not Create Class</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null
      }
      onSelect={select}
      data-testid={pickerTestId}
    />
  );
}

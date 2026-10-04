import { useMemo } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { displayPickerTitle } from "./picker-identity";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";
import { useAssetCreate, type ClassCreateOptions } from "./asset-create-context";
import { usePickerCreate } from "./use-picker-create";

export interface ClassPickerEntry {
  id: string;
  name: string;
  description?: string;
  group?: string;
  /** Most-specific first; project classes resolve their engine-base glyph from it. */
  ancestry?: readonly string[];
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
   * AssetCreateProvider can create a child of it. Omit for type or parent
   * choosers, which cannot know the parent a new Class needs.
   */
  createBaseClass?: string;
  /** Added to every Create New Class request, such as the owning document. */
  createOptions?: ClassCreateOptions;
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
  createOptions,
  "data-testid": testId,
}: ClassPickerProps) {
  const api = useAssetCreate();
  const base = createBaseClass?.trim() ?? "";
  // Checked while open only: the host's parent rule walks the project Classes.
  const createClass = useMemo(
    () =>
      open && base && api?.createClass && (api.canCreateClass?.(base) ?? true)
        ? api.createClass
        : undefined,
    [api, base, open],
  );
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
            ...(entry.ancestry ? { ancestry: [...entry.ancestry] } : {}),
            family: "class",
          })}
        />
      ),
    }));
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
  }, [allowNone, base, classes, createClass, creatingId]);

  const select = (id: string, query: string) => {
    if (id === NONE_ID) {
      onPick(null);
      return;
    }
    if (id === CREATE_ID && createClass) {
      const name = query.trim() || undefined;
      void run(id, () =>
        createClass({ ...createOptions, parentClass: base, name }),
      );
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

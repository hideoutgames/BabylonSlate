import { useMemo } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { displayPickerTitle } from "./picker-identity";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";
import { useAssetCreate, type AssetCreateOptions } from "./asset-create-context";
import { usePickerCreate } from "./use-picker-create";

export interface AssetPickerEntry {
  guid: string;
  name: string;
  type: string;
  path?: string;
}

export interface AssetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: AssetPickerEntry[];
  /** Restrict the list to these asset types; empty means all. */
  allowedTypes?: string[];
  onPick: (guid: string | null) => void;
  title?: string;
  /** Show a "None" row so a property can be cleared. */
  allowNone?: boolean;
  /**
   * Added to every Create New request, such as a Material domain or the
   * owning document. Rows are offered for `allowedTypes` with 1–3 entries
   * that an AssetCreateProvider can create.
   */
  createOptions?: AssetCreateOptions;
  "data-testid"?: string;
}

const NONE_ID = "__none__";
const CREATE_PREFIX = "__create__";
/** Wider type filters (Asset variables) would bury the list under create rows. */
const MAX_CREATE_TYPES = 3;

/** Asset reference picker built on the shared search dialog. */
export function AssetPicker({
  open,
  onOpenChange,
  assets,
  allowedTypes,
  onPick,
  title = "Pick Asset",
  allowNone = true,
  createOptions,
  "data-testid": testId,
}: AssetPickerProps) {
  const api = useAssetCreate();
  const { creatingId, error, run } = usePickerCreate({
    open,
    onOpenChange,
    onPick,
  });
  const offeredCreateTypes = useMemo(() => {
    if (
      !api ||
      !allowedTypes ||
      allowedTypes.length === 0 ||
      allowedTypes.length > MAX_CREATE_TYPES
    ) {
      return [];
    }
    return [...new Set(allowedTypes)].filter((type) => api.canCreate(type));
  }, [allowedTypes, api]);
  const items = useMemo<SearchDialogItem[]>(() => {
    const filtered =
      allowedTypes && allowedTypes.length > 0
        ? assets.filter((asset) => allowedTypes.includes(asset.type))
        : assets;
    const rows: SearchDialogItem[] = filtered.map((asset) => ({
      id: asset.guid,
      label: displayPickerTitle(asset.name),
      description: [asset.type, asset.path].filter(Boolean).join(" · "),
      group: asset.path,
      leading: (
        <TypeVisualIcon visual={resolveTypeVisual({ assetType: asset.type })} />
      ),
    }));
    const createRows: SearchDialogItem[] = api
      ? offeredCreateTypes.map((type) => {
          const id = `${CREATE_PREFIX}${type}`;
          return {
            id,
            label: `Create New ${api.typeLabel(type)}`,
            description:
              creatingId === id ? "Creating…" : "Uses the search text as its name",
            leading: (
              <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} />
            ),
            pinned: true,
            keepOpen: true,
          };
        })
      : [];
    return [
      ...(allowNone
        ? [{ id: NONE_ID, label: "None", description: "Clear reference" }]
        : []),
      ...createRows,
      ...rows,
    ];
  }, [allowNone, allowedTypes, api, assets, creatingId, offeredCreateTypes]);

  const select = (id: string, query: string) => {
    if (id === NONE_ID) {
      onPick(null);
      return;
    }
    if (api && id.startsWith(CREATE_PREFIX)) {
      const type = id.slice(CREATE_PREFIX.length);
      const name = query.trim() || undefined;
      void run(id, () => api.createAsset({ ...createOptions, type, name }));
      return;
    }
    onPick(id);
  };

  const pickerTestId = testId ?? "asset-picker";
  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search Assets"
      emptyLabel="No Assets Of This Type"
      busy={creatingId !== null}
      status={
        error ? (
          <Alert variant="destructive" data-testid={`${pickerTestId}-error`}>
            <AlertTitle>Could Not Create Asset</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null
      }
      onSelect={select}
      data-testid={pickerTestId}
    />
  );
}

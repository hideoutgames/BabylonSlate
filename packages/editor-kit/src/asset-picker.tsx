import { useMemo } from "react";
import { SearchDialog, type SearchDialogItem } from "./search-dialog";
import { displayPickerTitle } from "./picker-identity";
import { TypeVisualIcon, resolveTypeVisual } from "./type-visuals";

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
  "data-testid"?: string;
}

const NONE_ID = "__none__";

/** Asset reference picker built on the shared search dialog. */
export function AssetPicker({
  open,
  onOpenChange,
  assets,
  allowedTypes,
  onPick,
  title = "Pick asset",
  allowNone = true,
  "data-testid": testId,
}: AssetPickerProps) {
  const items = useMemo<SearchDialogItem[]>(() => {
    const filtered =
      allowedTypes && allowedTypes.length > 0
        ? assets.filter((asset) => allowedTypes.includes(asset.type))
        : assets;
    const rows: SearchDialogItem[] = filtered.map((asset) => ({
      id: asset.guid,
      label: displayPickerTitle(asset.name),
      description: asset.type,
      group: asset.path,
      leading: (
        <TypeVisualIcon visual={resolveTypeVisual({ assetType: asset.type })} />
      ),
    }));
    return allowNone
      ? [{ id: NONE_ID, label: "None", description: "Clear reference" }, ...rows]
      : rows;
  }, [allowNone, allowedTypes, assets]);

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={items}
      placeholder="Search assets"
      emptyLabel="No assets of this type"
      onSelect={(id) => onPick(id === NONE_ID ? null : id)}
      data-testid={testId ?? "asset-picker"}
    />
  );
}

import type { ReactNode } from "react";
import { TypeVisualIcon, resolveTypeVisual, type TypeVisualQuery } from "./type-visuals";

export interface PickerIdentityProps {
  label: string;
  description?: string;
  leading?: ReactNode;
  visual?: TypeVisualQuery;
}

/** Icon + name + muted type line shared by picker triggers and SearchDialog rows. */
export function PickerIdentity({
  label,
  description,
  leading,
  visual,
}: PickerIdentityProps) {
  const glyph =
    leading ??
    (visual ? <TypeVisualIcon visual={resolveTypeVisual(visual)} /> : null);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {glyph}
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate">{label}</span>
        {description ? (
          <span className="truncate text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Strip a trailing `.Type` suffix so the type line is not duplicated in the name. */
export function displayPickerTitle(name: string): string {
  return name.replace(/\.[A-Za-z][A-Za-z0-9]*$/, "");
}

export function assetRowIdentity(
  asset: { name: string; type: string; path?: string } | undefined,
): {
  displayLabel?: string;
  displayType?: string;
  visual?: TypeVisualQuery;
  path?: string;
} {
  if (!asset) return {};
  return {
    displayLabel: displayPickerTitle(asset.name),
    displayType: asset.type,
    visual: { assetType: asset.type },
    path: asset.path,
  };
}

export function classRowIdentity(
  entry: { id: string; name: string } | undefined,
  fallbackId?: string | null,
): {
  displayLabel?: string;
  displayType?: string;
  visual?: TypeVisualQuery;
} {
  const id = entry?.id ?? fallbackId?.trim();
  if (!id) return {};
  return {
    displayLabel: displayPickerTitle(entry?.name ?? id),
    displayType: "Class",
    visual: { classId: id, family: "class" },
  };
}

/** Closed picker button contents: identity row, or a plain empty label. */
export function selectedPickerIdentity(
  identity: {
    displayLabel?: string;
    displayType?: string;
    visual?: TypeVisualQuery;
  },
  emptyLabel = "None",
) {
  if (!identity.displayLabel) return emptyLabel;
  return (
    <PickerIdentity
      label={identity.displayLabel}
      description={identity.displayType}
      visual={identity.visual}
    />
  );
}

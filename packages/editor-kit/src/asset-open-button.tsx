import { SquareArrowOutUpRightIcon } from "lucide-react";
import { documentKindForAssetType } from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";

/** Minimal slice of `AssetPickerEntry` needed to decide openability.
 *
 * `type` MUST be the asset header type string (e.g. `asset.header.type`).
 * Passing a raw registry entry (`IndexedAsset`) is wrong: its type lives at
 * `entry.header.type`, so the button would silently never render. */
export interface AssetOpenEntry {
  type?: string;
  path?: string;
}

export interface AssetOpenButtonProps {
  /** Currently referenced asset; the button renders nothing when it cannot open. */
  entry: AssetOpenEntry | null | undefined;
  onOpen: () => void;
  label?: string;
  "data-testid"?: string;
}

/**
 * True when an asset reference can be opened as an editor document tab: it must
 * carry a path and its type must map to a document kind (core mapping, shared
 * with the Content Browser). Independent of whether the tab is already open.
 */
export function canOpenAssetInTab(
  entry: AssetOpenEntry | null | undefined,
): boolean {
  return (
    Boolean(entry?.path) && documentKindForAssetType(entry?.type ?? "") !== null
  );
}

/**
 * Square icon button docked to the right of an asset picker field that opens
 * (or focuses) the referenced asset in an editor tab. Stretch inside an
 * `items-stretch` flex row so width always equals the rendered picker height.
 * Renders nothing when the entry is missing, has no path, or its type does not
 * map to a document kind.
 */
export function AssetOpenButton({
  entry,
  onOpen,
  label = "Open in tab",
  "data-testid": testId,
}: AssetOpenButtonProps) {
  if (!canOpenAssetInTab(entry)) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-auto w-auto shrink-0 self-stretch aspect-square px-0"
      aria-label={label}
      title={label}
      onClick={onOpen}
      data-testid={testId ?? "asset-open-button"}
    >
      <SquareArrowOutUpRightIcon aria-hidden="true" />
    </Button>
  );
}

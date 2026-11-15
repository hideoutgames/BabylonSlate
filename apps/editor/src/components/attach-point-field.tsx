import { useState } from "react";
import { PropertyGrid, SearchDropdown, type SearchDialogItem } from "@haptic/editor-kit";
import { BoneIcon, CrosshairIcon, ListIcon } from "lucide-react";
import type { SkeletonAttachPoints } from "../lib/skeleton-attach-points";
import { IconActionButton } from "./icon-action-button";

const SEPARATOR = "\u0000";

/** The list rows: each Skeleton's sockets, then its bones, under the Skeleton's name. */
function attachPointItems(groups: readonly SkeletonAttachPoints[]): SearchDialogItem[] {
  return groups.flatMap((group) => [
    ...group.sockets.map((name) => ({
      id: `${group.skeletonGuid}${SEPARATOR}${name}`,
      label: name,
      description: "Socket",
      group: group.skeletonName,
      leading: <CrosshairIcon aria-hidden />,
    })),
    ...group.bones.map((name) => ({
      id: `${group.skeletonGuid}${SEPARATOR}${name}`,
      label: name,
      description: "Bone",
      group: group.skeletonName,
      leading: <BoneIcon aria-hidden />,
    })),
  ]);
}

/**
 * A bone or socket name: typed, or picked from the bones and sockets of the given Skeletons (the list button). Empty
 * means none.
 */
export function AttachPointField({
  id,
  label,
  value,
  groups,
  disabled = false,
  hideLabel = false,
  onChange,
  "data-testid": testId,
}: {
  id: string;
  label: string;
  value: string;
  groups: readonly SkeletonAttachPoints[];
  disabled?: boolean;
  hideLabel?: boolean;
  onChange: (name: string) => void;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <PropertyGrid
          rows={[{
            id,
            kind: "text",
            label,
            value,
            disabled,
            onChange: () => undefined,
            onCommit: (next) => onChange(next.trim()),
          }]}
          hideLabels={hideLabel}
          density="compact"
          orientation="horizontal"
          readOnly={disabled}
        />
      </div>
      {groups.length > 0 ? (
        <SearchDropdown
          open={open}
          onOpenChange={setOpen}
          title="Pick Bone or Socket"
          placeholder="Search bones and sockets"
          items={attachPointItems(groups)}
          onSelect={(itemId) => {
            setOpen(false);
            onChange(itemId.slice(itemId.indexOf(SEPARATOR) + 1));
          }}
          data-testid={testId ? `${testId}-picker` : undefined}
        >
          <IconActionButton
            label="Pick Bone or Socket"
            variant="ghost"
            disabled={disabled}
            data-testid={testId ? `${testId}-pick` : undefined}
          >
            <ListIcon />
          </IconActionButton>
        </SearchDropdown>
      ) : null}
    </div>
  );
}

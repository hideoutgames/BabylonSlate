import { LockIcon, MinusIcon, PlusIcon, UserLockIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@haptic/ui/lib/utils";

/**
 * What changed about a file or an item: the Changes and History words
 * (`added`, `modified`, `deleted`) or the asset diff's (`added`, `changed`,
 * `removed`). Each marker names its own word.
 */
export type SourceControlStatus = "added" | "modified" | "deleted" | "changed" | "removed";

const STATUS_LABEL: Record<SourceControlStatus, string> = {
  added: "Added",
  modified: "Modified",
  changed: "Changed",
  deleted: "Deleted",
  removed: "Removed",
};

type Shape = "added" | "modified" | "removed";

const SHAPE: Record<SourceControlStatus, Shape> = {
  added: "added",
  modified: "modified",
  changed: "modified",
  deleted: "removed",
  removed: "removed",
};

const TONE: Record<Shape, string> = {
  added: "text-(--success)",
  modified: "text-(--warning)",
  removed: "text-destructive",
};

/**
 * One status marker for every Source Control view: a green plus for added, a
 * red minus for removed or deleted, an amber M for modified or changed. The
 * glyphs differ in shape, not only colour, and the marker is an image named
 * by its status word. `inline` ends a row (Changes, History, Actors, the
 * Content Browser tree); `badge` sits in a solid chip over a tile's
 * thumbnail, so it reads on any image in either theme.
 */
export function StatusMarker({
  status,
  variant = "inline",
  className,
  ...props
}: { status: SourceControlStatus; variant?: "inline" | "badge" } & Omit<ComponentProps<"span">, "children">) {
  const shape = SHAPE[status];
  const label = STATUS_LABEL[status];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold leading-none",
        variant === "badge"
          ? "size-[18px] rounded-sm border border-border bg-popover text-[10px] shadow-xs [&_svg]:size-3"
          : "size-3.5 text-xs [&_svg]:size-3.5",
        TONE[shape],
        className,
      )}
      {...props}
    >
      {shape === "added" ? <PlusIcon strokeWidth={3} aria-hidden="true" /> : null}
      {shape === "removed" ? <MinusIcon strokeWidth={3} aria-hidden="true" /> : null}
      {shape === "modified" ? "M" : null}
    </span>
  );
}

/** Who holds a lock, as its badge and the Content Browser's Source Control menu name it. */
// The badge's name belongs with the badge.
// eslint-disable-next-line react-refresh/only-export-components
export function lockHolderLabel(state: "mine" | "theirs", ownerName?: string): string {
  return state === "mine" ? "Locked By You" : `Locked By ${ownerName || "Another User"}`;
}

/**
 * A Git LFS lock: this device's own as a filled chip with a lock, someone
 * else's as an outlined red chip with a person and a lock, so they differ in
 * shape and glyph as well as colour. The image is named for the holder
 * (`Locked By You`, `Locked By Bob`), also as its tooltip. `md` sits in a
 * tile's corner; `sm` ends a row.
 */
export function LockBadge({
  state,
  ownerName,
  size = "md",
  className,
  ...props
}: { state: "mine" | "theirs"; ownerName?: string; size?: "sm" | "md" } & Omit<ComponentProps<"span">, "children">) {
  const label = lockHolderLabel(state, ownerName);
  const Glyph = state === "mine" ? LockIcon : UserLockIcon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-lock-state={state}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm border",
        size === "md" ? "size-[18px] shadow-xs [&_svg]:size-3" : "size-4 [&_svg]:size-2.5",
        state === "mine"
          ? "border-primary bg-primary text-primary-foreground"
          : "border-destructive bg-popover text-destructive",
        className,
      )}
      {...props}
    >
      <Glyph strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}

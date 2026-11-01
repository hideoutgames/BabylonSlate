import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { cn } from "@haptic/ui/lib/utils";
import { SearchInput } from "./search-input";
import { useTouchUi } from "./touch-ui";

export interface ChecklistDialogItem {
  id: string;
  label: string;
  /** Right-aligned, such as a type mark. */
  trailing?: ReactNode;
  /** Extra search text. */
  keywords?: string;
  /** Already included: shown with a check and not selectable. */
  included?: boolean;
  testId?: string;
}

export interface ChecklistDialogGroup {
  id: string;
  label: string;
  icon?: ReactNode;
  items: readonly ChecklistDialogItem[];
}

export interface ChecklistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  groups: readonly ChecklistDialogGroup[];
  /** The confirm button's label, such as `Add Tracks`. */
  confirmLabel: string;
  onConfirm: (ids: string[]) => void;
  searchPlaceholder?: string;
  emptyLabel?: string;
  "data-testid"?: string;
}

const matches = (query: string, ...texts: Array<string | undefined>) =>
  texts.some((text) => text?.toLowerCase().includes(query));

/**
 * A centered dialog listing grouped items to check, with a search field and a
 * count of the checked items beside Cancel and the confirm button. Items
 * already included show a check and cannot be picked again. The checks reset
 * each time it opens.
 */
export function ChecklistDialog({
  open,
  onOpenChange,
  title,
  description,
  groups,
  confirmLabel,
  onConfirm,
  searchPlaceholder = "Search",
  emptyLabel = "No Matches",
  "data-testid": testId,
}: ChecklistDialogProps) {
  const touch = useTouchUi();
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const idPrefix = useId();
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setChecked(new Set());
  }, [open]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups.filter((group) => group.items.length > 0);
    return groups.flatMap((group) => {
      const items = matches(needle, group.label) ? group.items
        : group.items.filter((item) => matches(needle, item.label, item.keywords));
      return items.length ? [{ ...group, items }] : [];
    });
  }, [groups, query]);

  const toggle = (id: string, on: boolean) => setChecked((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const confirm = () => {
    if (checked.size === 0) return;
    // In list order, whatever the order they were checked in.
    const order = groups.flatMap((group) => group.items.map((item) => item.id));
    onConfirm(order.filter((id) => checked.has(id)));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(36rem,calc(100dvh-4rem))] sm:max-w-md"
        bodyClassName="flex flex-col gap-3 overflow-hidden"
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          autoFocus={!touch}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirm();
            }
          }}
          data-testid={testId ? `${testId}-search` : undefined}
        />
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1" role="list">
          {visible.length === 0 ? <p className="py-6 text-center text-muted-foreground">{emptyLabel}</p> : null}
          {visible.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`${idPrefix}-${group.id}`} className="pb-2">
              <div id={`${idPrefix}-${group.id}`} className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
                {group.icon}
                <span className="truncate">{group.label}</span>
              </div>
              {group.items.map((item) => {
                const isChecked = checked.has(item.id);
                const inputId = `${idPrefix}-${group.id}-${item.id}`;
                return (
                  <label
                    key={item.id}
                    htmlFor={item.included ? undefined : inputId}
                    role="listitem"
                    data-testid={item.testId}
                    data-included={item.included ? "true" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-1.5",
                      touch ? "min-h-11" : "h-7",
                      item.included ? "text-muted-foreground" : "cursor-pointer hover:bg-accent/50",
                      isChecked && "bg-accent/60",
                    )}
                  >
                    {item.included
                      ? <CheckIcon className="size-4 shrink-0" aria-label="Included" />
                      : <Checkbox id={inputId} checked={isChecked} onCheckedChange={(on) => toggle(item.id, on === true)} />}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.trailing ? <span className="shrink-0 text-xs text-muted-foreground">{item.trailing}</span> : null}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <DialogFooter className="justify-between">
          <span className="text-xs text-muted-foreground" aria-live="polite">{checked.size} selected</span>
          <span className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" disabled={checked.size === 0} onClick={confirm} data-testid={testId ? `${testId}-confirm` : undefined}>
              {confirmLabel}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

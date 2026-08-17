import { useMemo, useState, type ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { SearchInput } from "./search-input";
import {
  filterSearchItems,
  groupSearchItems,
  type SearchDialogItem,
} from "./search-dialog";
import { PickerIdentity } from "./picker-identity";

export interface SearchDropdownProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: string;
  items: SearchDialogItem[];
  onSelect: (id: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  children: ReactElement;
  "data-testid"?: string;
}

/** Searchable dropdown anchored to a trigger. Use for pick lists with a nearby button. */
export function SearchDropdown({
  open,
  onOpenChange,
  title,
  description,
  items,
  onSelect,
  placeholder = "Search",
  emptyLabel = "No matches",
  children,
  "data-testid": testId,
}: SearchDropdownProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterSearchItems(items, query), [items, query]);
  const grouped = useMemo(() => groupSearchItems(filtered), [filtered]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange?.(next);
      }}
    >
      <DropdownMenuTrigger render={children} />
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-max min-w-64 max-w-sm overflow-y-auto"
        data-testid={testId}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
        </DropdownMenuGroup>
        {description ? (
          <p className="px-1.5 pb-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
        <div
          className="px-1 pb-1"
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <SearchInput
            className="min-h-[var(--touch-target,44px)]"
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={setQuery}
            data-testid={testId ? `${testId}-query` : undefined}
          />
        </div>
        {grouped.map((section, index) => (
          <DropdownMenuGroup key={section.group ?? `ungrouped-${index}`}>
            {section.group ? (
              <DropdownMenuLabel>{section.group}</DropdownMenuLabel>
            ) : null}
            {section.items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                className="min-h-[var(--touch-target,44px)]"
                onClick={() => {
                  onSelect(item.id);
                  onOpenChange?.(false);
                }}
                data-testid={`search-item-${item.id}`}
              >
                <PickerIdentity
                  label={item.label}
                  description={item.description}
                  leading={item.leading}
                />
                {item.trailing}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        {filtered.length === 0 ? (
          <DropdownMenuGroup>
            <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import type { Dispatch, SetStateAction } from "react";
import {
  ArrowUpDownIcon,
  ListFilterIcon,
} from "lucide-react";
import {
  TypeVisualIcon,
  resolveTypeVisual,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import {
  CONTENT_BROWSER_SORT_OPTIONS,
  type ContentBrowserSortMode,
} from "../lib/content-browser-helpers";

interface ContentBrowserFilterSortMenusProps {
  phone: boolean;
  phoneIconSize: "touch-icon" | "icon-sm";
  typeChips: readonly string[];
  typeFilters: string[];
  setTypeFilters: Dispatch<SetStateAction<string[]>>;
  sortMode: ContentBrowserSortMode;
  setSortMode: (mode: ContentBrowserSortMode) => void;
}

/** The toolbar Filter (asset types) and Sort menus. */
export function ContentBrowserFilterSortMenus({
  phone,
  phoneIconSize,
  typeChips,
  typeFilters,
  setTypeFilters,
  sortMode,
  setSortMode,
}: ContentBrowserFilterSortMenusProps) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant={typeFilters.length > 0 ? "secondary" : "outline"}
              size={phone ? phoneIconSize : "sm"}
              data-testid="content-browser-filter"
              aria-label={
                typeFilters.length > 0
                  ? `Filter (${typeFilters.length})`
                  : "Filter"
              }
            />
          }
        >
          <ListFilterIcon data-icon="inline-start" />
          {!phone
            ? `Filter${typeFilters.length > 0 ? ` (${typeFilters.length})` : ""}`
            : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-44"
          data-testid="content-browser-filter-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Asset Types</DropdownMenuLabel>
            {typeChips.map((type) => (
              <DropdownMenuCheckboxItem
                key={type}
                checked={typeFilters.includes(type)}
                data-testid={`content-browser-filter-${type}`}
                onCheckedChange={(checked) => {
                  setTypeFilters((current) =>
                    checked === true
                      ? current.includes(type)
                        ? current
                        : [...current, type]
                      : current.filter((entry) => entry !== type),
                  );
                }}
              >
                <TypeVisualIcon
                  visual={resolveTypeVisual({ assetType: type })}
                  className="size-4"
                />
                {type}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size={phone ? phoneIconSize : "sm"}
              data-testid="content-browser-sort"
              aria-label="Sort"
            />
          }
        >
          <ArrowUpDownIcon data-icon="inline-start" />
          {!phone ? "Sort" : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-44"
          data-testid="content-browser-sort-menu"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort By</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(value) => {
                const next = CONTENT_BROWSER_SORT_OPTIONS.find(
                  (option) => option.mode === value,
                );
                if (next) setSortMode(next.mode);
              }}
            >
              {CONTENT_BROWSER_SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem
                  key={option.mode}
                  value={option.mode}
                  data-testid={`content-browser-sort-${option.mode}`}
                >
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

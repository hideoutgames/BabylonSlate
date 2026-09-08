import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Badge } from "@babylonslate/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { SearchInput, TypeVisualIcon } from "@babylonslate/editor-kit";
import { Separator } from "@babylonslate/ui/components/separator";
import { useProjectSearch } from "../context/project-search-context";
import {
  groupSearchEntries,
  visualForSearchEntry,
} from "../lib/search-navigation";

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    query,
    openSearchResult,
    searchStatus,
    beginSearchRebuild,
    cancelSearchRebuild,
  } = useProjectSearch();
  const [needle, setNeedle] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const pending = searchStatus === "pending";

  useEffect(() => {
    if (open) {
      beginSearchRebuild();
      return;
    }
    cancelSearchRebuild();
    setNeedle("");
    setActiveId(null);
  }, [beginSearchRebuild, cancelSearchRebuild, open]);

  const grouped = useMemo(
    () => groupSearchEntries(query(needle)),
    [needle, query],
  );
  const hasQuery = needle.trim().length > 0;
  const hasHits = grouped.length > 0;
  const entries = useMemo(
    () => grouped.flatMap((group) => group.entries),
    [grouped],
  );
  const activeEntry =
    pending || !hasQuery
      ? undefined
      : (entries.find((entry) => entry.id === activeId) ?? entries[0]);
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;

  useEffect(() => {
    activeResultRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeEntry?.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={inputRef}
        className="flex h-[min(90svh,52rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="global-search-dialog"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>Search Project</DialogTitle>
          <DialogDescription>
            Find assets, actors, graph nodes, classes, and variables.
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 border-b px-4 py-3">
          <SearchInput
            ref={inputRef}
            autoFocus
            className="min-h-[var(--touch-target,44px)]"
            aria-label="Search Project"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!pending && hasHits}
            aria-controls={!pending && hasHits ? listId : undefined}
            aria-activedescendant={
              activeEntry ? optionId(activeEntry.id) : undefined
            }
            placeholder="Search assets, actors, nodes…"
            value={needle}
            onChange={(value) => {
              setNeedle(value);
              setActiveId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") return;
              event.stopPropagation();
              if (event.nativeEvent.isComposing || pending || !activeEntry)
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = entries.findIndex(
                  (entry) => entry.id === activeEntry.id,
                );
                const next = Math.max(
                  0,
                  Math.min(
                    entries.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
                setActiveId(entries[next]!.id);
              } else if (event.key === "Enter") {
                event.preventDefault();
                void openSearchResult(activeEntry);
                onOpenChange(false);
              }
            }}
            data-testid="global-search-query"
          />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="global-search-results"
        >
          {pending ? (
            <Empty
              className="border-0 py-8"
              data-testid="global-search-pending"
            >
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Loader2Icon className="animate-spin" />
                </EmptyMedia>
                <EmptyTitle>Indexing Project</EmptyTitle>
                <EmptyDescription>
                  Building the search snapshot.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !hasQuery ? (
            <Empty className="border-0 py-8" data-testid="global-search-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>Type To Search</EmptyTitle>
                <EmptyDescription>
                  Names, class ids, graph nodes, and variable names.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !hasHits ? (
            <Empty
              className="border-0 py-8"
              data-testid="global-search-no-matches"
            >
              <EmptyHeader>
                <EmptyTitle>No Matches</EmptyTitle>
                <EmptyDescription>
                  Nothing in this project contains “{needle.trim()}”.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label="Search Results"
              className="flex flex-col gap-3 p-2"
            >
              {grouped.map((group, index) => (
                <div
                  key={group.kind}
                  role="group"
                  aria-label={group.label}
                  className="flex flex-col gap-1"
                  data-testid={`global-search-group-${group.kind}`}
                >
                  {index > 0 ? <Separator /> : null}
                  <p className="px-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                  {group.entries.map((entry) => (
                    <Button
                      key={entry.id}
                      id={optionId(entry.id)}
                      ref={
                        entry.id === activeEntry?.id
                          ? activeResultRef
                          : undefined
                      }
                      role="option"
                      aria-selected={entry.id === activeEntry?.id}
                      tabIndex={-1}
                      variant="ghost"
                      className="global-search-result min-h-[var(--touch-target,44px)] w-full justify-between gap-2 text-left"
                      onClick={() => {
                        void openSearchResult(entry);
                        onOpenChange(false);
                      }}
                      data-testid={`global-search-item-${entry.id}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <TypeVisualIcon visual={visualForSearchEntry(entry)} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{entry.label}</span>
                          {entry.description ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {entry.description}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <Badge variant="outline">{group.label}</Badge>
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-panel-header px-4 py-2 text-xs text-muted-foreground">
          <span aria-live="polite">
            {pending ? "Indexing…" : `${hasQuery ? entries.length : 0} Results`}
          </span>
          <span>
            <kbd>↑ ↓</kbd> Navigate <span className="px-1">·</span>{" "}
            <kbd>Enter</kbd> Open <span className="px-1">·</span> <kbd>Esc</kbd>{" "}
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

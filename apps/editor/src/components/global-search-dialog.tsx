import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
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
import { groupSearchEntries, visualForSearchEntry } from "../lib/search-navigation";

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { query, openSearchResult } = useProjectSearch();
  const [needle, setNeedle] = useState("");

  useEffect(() => {
    if (!open) setNeedle("");
  }, [open]);

  const grouped = useMemo(
    () => groupSearchEntries(query(needle)),
    [needle, query],
  );
  const hasQuery = needle.trim().length > 0;
  const hasHits = grouped.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(90svh,52rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-testid="global-search-dialog"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>Search project</DialogTitle>
          <DialogDescription>
            Find assets, actors, graph nodes, classes, and variables.
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 border-b px-4 py-3">
          <SearchInput
            autoFocus
            className="min-h-[var(--touch-target,44px)]"
            aria-label="Search project"
            placeholder="Search assets, actors, nodes…"
            value={needle}
            onChange={setNeedle}
            data-testid="global-search-query"
          />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="global-search-results"
        >
          {!hasQuery ? (
            <Empty className="border-0 py-8" data-testid="global-search-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>Type to search</EmptyTitle>
                <EmptyDescription>
                  Names, class ids, graph nodes, and variable names.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !hasHits ? (
            <Empty className="border-0 py-8" data-testid="global-search-no-matches">
              <EmptyHeader>
                <EmptyTitle>No matches</EmptyTitle>
                <EmptyDescription>
                  Nothing in this project contains “{needle.trim()}”.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              {grouped.map((group, index) => (
                <div
                  key={group.kind}
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
                      variant="ghost"
                      className="min-h-[var(--touch-target,44px)] w-full justify-between gap-2 text-left"
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
      </DialogContent>
    </Dialog>
  );
}

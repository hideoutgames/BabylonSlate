import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import type { CommitInfo } from "@haptic/source-control";
import { TOUCH_ROW_HEIGHT, TREE_ROW_HEIGHT, useTouchUi, WindowedList } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { HEAD, REMOTE, refLabel, shortId, WORKING_COPY, type DiffRef } from "../services/source-control-diff";
import { HISTORY_PAGE } from "../services/source-control-history";
import { useSourceControlDiff, useSourceControlDiffState } from "./source-control-actions";

function commitLabel(commit: CommitInfo): string {
  return `${shortId(commit.id)} · ${commit.message.split("\n")[0]!.trim()}`;
}

function RefPicker({ title, value, onChange, path, testId }: { title: string; value: DiffRef; onChange: (ref: DiffRef) => void; path: string; testId: string }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const touch = useTouchUi();
  const [open, setOpen] = useState(false);
  // History's list of the asset: read once (when History or a menu first asks), paged by either.
  const history = sync.commitHistory;
  const list = useSyncExternalStore(history.subscribe, () => history.list(path));
  const commits = list?.commits ?? [];
  // While the menu is open (it is not modal), read the list again once it is gone: a commit, pull or
  // switch moved the branch or its commit, or other assets' reads pushed it out of the few kept.
  const missing = list === null;
  const { active, branch, head } = snapshot;
  useEffect(() => {
    if (open && active && missing) history.load(path);
  }, [active, branch, head, history, missing, open, path]);
  const item = (ref: DiffRef, label: string, disabled = false) => (
    <DropdownMenuItem key={ref.kind === "commit" ? ref.id : ref.kind} disabled={disabled} onClick={() => onChange(ref)} data-testid={`${testId}-${ref.kind === "commit" ? ref.id : ref.kind}`}>
      <span className="truncate">{label}</span>
    </DropdownMenuItem>
  );
  const commitItem = (commit: CommitInfo) => item({ kind: "commit", id: commit.id }, commitLabel(commit));
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(next) => setOpen(next)}>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" data-testid={testId} />}>
        <span className="text-muted-foreground">{title}</span>
        <span className="max-w-40 truncate">{refLabel(value, snapshot)}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-96">
        <DropdownMenuGroup>
          {item(WORKING_COPY, "Working Copy")}
          {item(HEAD, `HEAD · ${refLabel(HEAD, snapshot)}`, snapshot.head === null)}
          {item(REMOTE, refLabel(REMOTE, snapshot), snapshot.remoteHead === null)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Commits</DropdownMenuLabel>
          {!list?.ready ? <DropdownMenuItem disabled>Reading History…</DropdownMenuItem> : null}
          {list?.error ? <DropdownMenuItem disabled>{list.error}</DropdownMenuItem> : null}
          {list?.ready && !list.error && commits.length === 0 ? <DropdownMenuItem disabled>No Commits</DropdownMenuItem> : null}
          {/* Past History's first page the rows are windowed in their own scroll region. */}
          {commits.length > HISTORY_PAGE ? (
            <ScrollArea className="h-72" data-testid={`${testId}-commits`}>
              <WindowedList itemCount={commits.length} rowHeight={touch ? TOUCH_ROW_HEIGHT : TREE_ROW_HEIGHT}>
                {(index) => commitItem(commits[index]!)}
              </WindowedList>
            </ScrollArea>
          ) : (
            <div data-testid={`${testId}-commits`}>{commits.map(commitItem)}</div>
          )}
          {list?.hasMore ? (
            <DropdownMenuItem closeOnClick={false} disabled={list.loadingOlder} onClick={() => void history.loadOlder(path)} data-testid={`${testId}-load-older`}>
              Load Older
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The global toolbar's document slot while the Source Control tab shows a
 * diff: the **Base** and **Compare** versions (working copy, HEAD, the
 * remote branch, or a commit that changed the asset, from the list History
 * shows for it, with **Load Older**).
 */
export function SourceControlDiffPickers() {
  const diff = useSourceControlDiff();
  const { target } = useSourceControlDiffState();
  if (!target) return null;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Versions" data-testid="diff-pickers">
      <RefPicker title="Base" value={target.base} path={target.path} onChange={(base) => diff.setRefs({ base })} testId="diff-base" />
      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <RefPicker title="Compare" value={target.compare} path={target.path} onChange={(compare) => diff.setRefs({ compare })} testId="diff-compare" />
    </div>
  );
}

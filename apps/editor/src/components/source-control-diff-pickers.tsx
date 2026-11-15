import { useState } from "react";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import type { CommitInfo } from "@haptic/source-control";
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
import { useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { HEAD, REMOTE, refLabel, shortId, WORKING_COPY, type DiffRef } from "../services/source-control-diff";
import { useSourceControlDiff, useSourceControlDiffState } from "./source-control-actions";

/** Recent commits offered as versions: enough to reach back a few days of work. */
const RECENT_COMMITS = 20;

function RefPicker({ title, value, onChange, path, testId }: { title: string; value: DiffRef; onChange: (ref: DiffRef) => void; path: string; testId: string }) {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const [commits, setCommits] = useState<readonly CommitInfo[] | null>(null);
  const loadCommits = (open: boolean) => {
    if (!open) return;
    // Read when the menu opens: the log is local, but there is no need to read it before.
    sync.commitsOf(path, RECENT_COMMITS).then(setCommits, () => setCommits([]));
  };
  const item = (ref: DiffRef, label: string, disabled = false) => (
    <DropdownMenuItem key={ref.kind === "commit" ? ref.id : ref.kind} disabled={disabled} onClick={() => onChange(ref)} data-testid={`${testId}-${ref.kind === "commit" ? ref.id : ref.kind}`}>
      {label}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu modal={false} onOpenChange={loadCommits}>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" data-testid={testId} />}>
        <span className="text-muted-foreground">{title}</span>
        <span className="max-w-40 truncate">{refLabel(value, snapshot)}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {item(WORKING_COPY, "Working Copy")}
          {item(HEAD, `HEAD · ${refLabel(HEAD, snapshot)}`, snapshot.head === null)}
          {item(REMOTE, refLabel(REMOTE, snapshot), snapshot.remoteHead === null)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Commits</DropdownMenuLabel>
          {commits === null ? <DropdownMenuItem disabled>Reading History…</DropdownMenuItem> : null}
          {commits?.length === 0 ? <DropdownMenuItem disabled>No Commits</DropdownMenuItem> : null}
          {commits?.map((commit) => item({ kind: "commit", id: commit.id }, `${shortId(commit.id)} · ${commit.message.split("\n")[0]!.trim()}`))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The global toolbar's document slot while the Source Control tab shows a
 * diff: the **Base** and **Compare** versions (working copy, HEAD, the
 * remote branch or a commit that changed the asset).
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

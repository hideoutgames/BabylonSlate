import type { IDockviewPanelProps } from "dockview-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Columns2Icon, CopyIcon, FileIcon, FolderIcon, HistoryIcon, SettingsIcon, Undo2Icon } from "lucide-react";
import type { ChangeKind, CommitInfo, FileChange } from "@haptic/source-control";
import {
  PanelFrame,
  resolveTypeVisual,
  SelectableText,
  TOUCH_ROW_HEIGHT,
  TypeVisualIcon,
  useTouchUi,
  WindowedList,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import { useIntegratedSync, useIntegratedSyncState, useRegistryState } from "../context/document-context";
import { useSourceControlActions } from "../components/source-control-actions";
import { IconActionButton } from "../components/icon-action-button";
import { groupChanges, registryChangeLookup, type ChangeLookup, type ChangeRow } from "../lib/source-control-changes";
import { agoLabel } from "../lib/source-control-labels";
import { shortId, WORKING_COPY } from "../services/source-control-diff";

/** Commits read per page: one screen or two, never the whole history. */
export const HISTORY_PAGE = 50;
/** Two lines (the subject, then author and time) at the compact density. */
const HISTORY_ROW_HEIGHT = 40;
const WORKING = "working";

const KIND_LETTER: Record<ChangeKind, string> = { added: "A", modified: "M", deleted: "D" };
const KIND_LABEL: Record<ChangeKind, string> = { added: "Added", modified: "Modified", deleted: "Deleted" };
const KIND_CLASS: Record<ChangeKind, string> = { added: "text-(--success)", modified: "text-(--warning)", deleted: "text-destructive" };

type Scope = "asset" | "all";

interface Loaded {
  /** What the pages were read for: the asset (or none), the branch and its commit. */
  key: string;
  commits: readonly CommitInfo[];
  hasMore: boolean;
  /** The last page ended at this shallow copy's oldest commit. */
  shallow: boolean;
  error: string | null;
}

function subjectOf(commit: CommitInfo): string {
  return commit.message.split("\n")[0]!.trim();
}

/** A path as the Changes window names it: an asset by its registry name, any other file by its own; null for a blob. */
function describe(path: string, lookup: ChangeLookup): ChangeRow | null {
  return groupChanges([{ path, kind: "modified" }], lookup).rows[0] ?? null;
}

function RowIcon({ type }: { type: string | null }) {
  if (type === "Folder") return <FolderIcon className="size-4 shrink-0" aria-hidden="true" />;
  if (type === "Project") return <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />;
  if (!type) return <FileIcon className="size-4 shrink-0" aria-hidden="true" />;
  return <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} />;
}

/** One commit (or the uncommitted changes); primitive props, so another page or selection re-renders only rows that change. */
const HistoryRow = memo(function HistoryRow({ id, subject, detail, hash, selected, onSelect }: {
  id: string;
  subject: string;
  detail: string;
  hash: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      className={cn("h-full w-full justify-start gap-2 rounded-md px-2 font-normal", selected && "bg-accent")}
      aria-pressed={selected}
      data-testid={`history-row-${id}`}
      onClick={() => onSelect(id)}
    >
      <span className={cn("size-2.5 shrink-0 rounded-full border-2", id === WORKING ? "border-(--warning)" : selected ? "border-foreground" : "border-muted-foreground")} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col items-start">
        <span className="w-full truncate text-left text-sm">{subject}</span>
        <span className="w-full truncate text-left text-xs text-muted-foreground">{detail}</span>
      </span>
      {hash ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{hash}</span> : null}
    </Button>
  );
});

/** A file of the selected commit (or of the uncommitted changes); opens its diff, when there is a version to compare it with. */
function AssetRow({ row, onOpen }: { row: ChangeRow; onOpen: ((row: ChangeRow) => void) | null }) {
  return (
    <li>
      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2 font-normal" disabled={!onOpen} data-testid={`history-asset-${row.id}`} onClick={() => onOpen?.(row)}>
        <RowIcon type={row.type} />
        <span className="truncate">{row.name}</span>
        <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">{row.folder}</span>
        <span className={cn("w-3.5 shrink-0 text-center text-xs font-bold", KIND_CLASS[row.kind])} title={KIND_LABEL[row.kind]}>{KIND_LETTER[row.kind]}</span>
      </Button>
    </li>
  );
}

/** The selected commit: its message, author, time and id, the actions on the History asset, and the assets it changed. */
function CommitDetails({ commit, asset, lookup, now }: { commit: CommitInfo; asset: ChangeRow | null; lookup: ChangeLookup; now: number }) {
  const sync = useIntegratedSync();
  const { openDiff, requestRevert } = useSourceControlActions();
  const [changes, setChanges] = useState<{ id: string; files: readonly FileChange[] | null; error: string | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    sync.commitChanges(commit.id).then((files) => {
      if (alive) setChanges({ id: commit.id, files, error: null });
    }, (error: unknown) => {
      if (alive) setChanges({ id: commit.id, files: null, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      alive = false;
    };
  }, [commit.id, sync]);

  const current = changes?.id === commit.id ? changes : null;
  const rows = useMemo(() => (current?.files ? groupChanges(current.files, lookup).rows : []), [current, lookup]);
  const body = commit.message.split("\n").slice(1).join("\n").trim();
  const parent = commit.parents[0] ?? null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commit.id);
      setCopied(commit.id);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="history-details">
      <div className="flex flex-col gap-1">
        <SelectableText className="text-sm font-semibold">{subjectOf(commit)}</SelectableText>
        {body ? <SelectableText className="whitespace-pre-wrap text-xs text-muted-foreground">{body}</SelectableText> : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate" title={new Date(commit.timestamp * 1000).toLocaleString()}>
            {commit.author.name} · {agoLabel(commit.timestamp * 1000, now)}
          </span>
          <SelectableText className="font-mono">{shortId(commit.id)}</SelectableText>
          <IconActionButton label={copied === commit.id ? "Copied" : "Copy Commit Id"} size="icon-xs" variant="ghost" data-testid="history-copy-id" onClick={() => void copy()}>
            <CopyIcon />
          </IconActionButton>
        </div>
      </div>
      {asset ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="history-compare"
            onClick={() => openDiff({ path: asset.id, name: asset.name, type: asset.type, base: { kind: "commit", id: commit.id }, compare: WORKING_COPY })}
          >
            <Columns2Icon data-icon="inline-start" />
            Compare With Working Copy
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="history-revert"
            onClick={() => requestRevert({ path: asset.id, name: asset.name, ref: { kind: "commit", id: commit.id } })}
          >
            <Undo2Icon data-icon="inline-start" />
            Revert To This Version
          </Button>
        </div>
      ) : null}
      <section className="flex flex-col rounded-md border bg-background py-1" aria-label="Assets In This Commit">
        <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground">Assets In This Commit</h3>
        {!current ? <p className="px-2 py-1 text-sm text-muted-foreground">Reading Changes…</p> : null}
        {current?.error ? <p className="px-2 py-1 text-sm text-destructive">{current.error}</p> : null}
        {current && !current.error && current.files === null ? (
          <p className="px-2 py-1 text-sm text-muted-foreground" data-testid="history-assets-shallow">Load Older History to see what this commit changed.</p>
        ) : null}
        {current?.files && rows.length === 0 ? <p className="px-2 py-1 text-sm text-muted-foreground">No Asset Changes.</p> : null}
        {rows.length > 0 ? (
          <ul className="flex flex-col" data-testid="history-assets">
            {rows.map((row) => (
              <AssetRow
                key={row.id}
                row={row}
                // What the commit did to it: its parent's version against the commit's (a first commit has none).
                onOpen={parent ? (open) => openDiff({ path: open.id, name: open.name, type: open.type, base: { kind: "commit", id: parent }, compare: { kind: "commit", id: commit.id } }) : null}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/** The uncommitted changes (of the History asset, or all): each opens its diff against HEAD. */
function WorkingDetails({ rows }: { rows: readonly ChangeRow[] }) {
  const { openDiff } = useSourceControlActions();
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="history-details">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Uncommitted Changes</span>
        <span className="text-xs text-muted-foreground">Working Copy</span>
      </div>
      <section className="flex flex-col rounded-md border bg-background py-1" aria-label="Changed Assets">
        <h3 className="px-2 py-1 text-xs font-semibold text-muted-foreground">Changed Assets</h3>
        <ul className="flex flex-col" data-testid="history-assets">
          {rows.map((row) => <AssetRow key={row.id} row={row} onOpen={(open) => openDiff({ path: open.id, name: open.name, type: open.type })} />)}
        </ul>
      </section>
    </div>
  );
}

/**
 * The Source Control tab's History window (Integrated mode): the commits of
 * the History asset (**This Asset**, the asset a diff or **Open History**
 * last showed) or of the branch (**All Assets**), newest first, uncommitted
 * changes first. Pages of `HISTORY_PAGE` commits come from the log (windowed
 * rows); **Load Older History** reads the next page, downloading older
 * history at the end of a shallow clone. The selected commit shows its
 * message, author, time and id, **Compare With Working Copy** and **Revert
 * To This Version** for the History asset, and the assets it changed.
 */
export function HistoryPanelContents() {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { historyPath } = useSourceControlActions();
  const { assetRegistry } = useRegistryState();
  const touch = useTouchUi();
  const [scope, setScope] = useState<Scope>("asset");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const lookup = useMemo(() => registryChangeLookup(assetRegistry), [assetRegistry]);
  const asset = useMemo(() => (historyPath ? describe(historyPath, lookup) : null), [historyPath, lookup]);
  const path = scope === "asset" ? historyPath : null;
  const { active, branch, head } = snapshot;
  // A commit, pull or switch moves the branch or its commit: the pages are read again.
  const key = [path ?? "", branch, head ?? ""].join("\n");

  useEffect(() => {
    if (!active) return;
    let alive = true;
    sync.history({ limit: HISTORY_PAGE, ...(path ? { path } : {}) }).then((page) => {
      if (alive) setLoaded({ key, ...page, error: null });
    }, (error: unknown) => {
      if (alive) setLoaded({ key, commits: [], hasMore: false, shallow: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      alive = false;
    };
  }, [active, key, path, sync]);

  const pages = loaded?.key === key ? loaded : null;
  const working = useMemo(() => (path ? snapshot.rows.filter((row) => row.id === path) : snapshot.rows), [path, snapshot.rows]);
  const ids = useMemo(() => [...(working.length > 0 ? [WORKING] : []), ...(pages?.commits.map((commit) => commit.id) ?? [])], [pages, working.length]);
  // The choice stays while its row is listed; otherwise the first row is shown.
  const shown = selected !== null && ids.includes(selected) ? selected : ids[0] ?? null;
  const commit = shown && shown !== WORKING ? pages?.commits.find((entry) => entry.id === shown) ?? null : null;
  const now = Date.now();

  const loadOlder = useCallback(async () => {
    if (!pages) return;
    setLoadingOlder(true);
    try {
      // After a page that ended at a shallow copy's oldest commit, a deepen may show that commit did not change the asset: read the pages again.
      const next = pages.shallow
        ? await sync.history({ limit: pages.commits.length + HISTORY_PAGE, deepen: true, ...(path ? { path } : {}) })
        : await sync.history({ limit: HISTORY_PAGE, skip: pages.commits.length, deepen: true, ...(path ? { path } : {}) });
      setLoaded((current) => {
        if (current?.key !== pages.key) return current;
        const commits = pages.shallow ? next.commits : [...current.commits, ...next.commits.filter((entry) => !current.commits.some((known) => known.id === entry.id))];
        return { ...current, commits, hasMore: next.hasMore, shallow: next.shallow, error: null };
      });
    } catch (error) {
      setLoaded((current) => (current?.key === pages.key ? { ...current, error: error instanceof Error ? error.message : String(error) } : current));
    } finally {
      setLoadingOlder(false);
    }
  }, [pages, path, sync]);

  if (!active) {
    return (
      <PanelFrame data-testid="history-panel">
        <p className="p-2 text-sm text-muted-foreground">{snapshot.blocked ? "Source control is not running in this folder." : "Opening The Repository…"}</p>
      </PanelFrame>
    );
  }

  const rowHeight = touch ? TOUCH_ROW_HEIGHT : HISTORY_ROW_HEIGHT;
  return (
    <PanelFrame data-testid="history-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
          {scope === "asset" && asset ? <RowIcon type={asset.type} /> : <HistoryIcon className="size-4 shrink-0" aria-hidden="true" />}
          <span className="truncate text-sm font-semibold" data-testid="history-title">{scope === "asset" && asset ? asset.name : "All Assets"}</span>
          <span className="shrink-0 text-xs text-muted-foreground">on {branch}</span>
          <span className="flex-1" />
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Show"
            value={[asset ? scope : "all"]}
            onValueChange={(value) => {
              if (value[0]) setScope(value[0] as Scope);
            }}
          >
            <ToggleGroupItem value="asset" disabled={!asset} data-testid="history-scope-asset">This Asset</ToggleGroupItem>
            <ToggleGroupItem value="all" data-testid="history-scope-all">All Assets</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {/* Side by side where the window is wide; the details under the list where it is narrow. */}
        <div className="@container/history flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col @2xl/history:flex-row">
            <div className="flex min-h-[calc(4*var(--chrome-row,28px))] flex-1 flex-col border-border @2xl/history:max-w-[50%] @2xl/history:border-r">
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-1">
                  {!pages ? <p className="p-1 text-sm text-muted-foreground">Reading History…</p> : null}
                  {pages && ids.length === 0 && !pages.error ? <p className="p-1 text-sm text-muted-foreground" data-testid="history-empty">No Commits Yet.</p> : null}
                  {ids.length > 0 ? (
                    <div role="list" aria-label="History" data-testid="history-list">
                      <WindowedList itemCount={ids.length} rowHeight={rowHeight}>
                        {(index) => {
                          const id = ids[index]!;
                          if (id === WORKING) {
                            return <HistoryRow id={WORKING} subject="Uncommitted Changes" detail="Working Copy" hash={null} selected={shown === WORKING} onSelect={setSelected} />;
                          }
                          const entry = pages!.commits[working.length > 0 ? index - 1 : index]!;
                          return (
                            <HistoryRow
                              id={entry.id}
                              subject={subjectOf(entry)}
                              detail={`${entry.author.name} · ${agoLabel(entry.timestamp * 1000, now)}`}
                              hash={shortId(entry.id)}
                              selected={shown === entry.id}
                              onSelect={setSelected}
                            />
                          );
                        }}
                      </WindowedList>
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
              {pages?.error ? <p role="alert" className="shrink-0 px-2 py-1 text-xs text-destructive" data-testid="history-error">{pages.error}</p> : null}
              {pages?.hasMore ? (
                <div className="flex shrink-0 items-center gap-2 border-t border-border p-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {pages.shallow ? "Older history is not downloaded yet." : null}
                  </span>
                  <Button variant="outline" size="sm" disabled={loadingOlder} data-testid="history-load-older" onClick={() => void loadOlder()}>
                    Load Older History
                  </Button>
                </div>
              ) : null}
            </div>
            <ScrollArea className="min-h-0 flex-1 border-t border-border bg-card @2xl/history:border-t-0">
              {shown === WORKING ? <WorkingDetails rows={working} /> : null}
              {/* Compare and Revert act on the asset the window names, so only This Asset offers them. */}
              {commit ? <CommitDetails commit={commit} asset={scope === "asset" ? asset : null} lookup={lookup} now={now} /> : null}
            </ScrollArea>
          </div>
        </div>
      </div>
    </PanelFrame>
  );
}

export function HistoryPanel(_props: IDockviewPanelProps) {
  void _props;
  return <HistoryPanelContents />;
}

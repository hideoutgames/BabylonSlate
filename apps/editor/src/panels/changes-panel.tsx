import type { IDockviewPanelProps } from "dockview-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LockIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import type { ChangeKind, CommitInfo } from "@haptic/source-control";
import { PanelFrame, resolveTypeVisual, TypeVisualIcon } from "@haptic/editor-kit";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Label } from "@haptic/ui/components/label";
import { Textarea } from "@haptic/ui/components/textarea";
import { cn } from "@haptic/ui/lib/utils";
import { useIntegratedSync, useIntegratedSyncState, useSourceControl } from "../context/document-context";
import { useSourceControlActions } from "../components/source-control-actions";
import { integratedBlockerLabel } from "../lib/source-control-mode";
import type { ChangeRow as ChangeRowData } from "../lib/source-control-changes";
import { agoLabel, syncStatusLine, transferLabel } from "../lib/source-control-labels";

const KIND_LETTER: Record<ChangeKind, string> = { added: "A", modified: "M", deleted: "D" };
const KIND_LABEL: Record<ChangeKind, string> = { added: "Added", modified: "Modified", deleted: "Deleted" };
const KIND_CLASS: Record<ChangeKind, string> = {
  added: "text-(--success)",
  modified: "text-(--warning)",
  deleted: "text-destructive",
};

function RowIcon({ type }: { type: string | null }) {
  if (type === "Folder") return <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  if (type === "Project") return <SettingsIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  if (!type) return <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  return <TypeVisualIcon visual={resolveTypeVisual({ assetType: type })} />;
}

/** One changed asset; primitive props, so a status that changes nothing about it does not re-render it. */
const ChangeRow = memo(function ChangeRow({
  id,
  name,
  folder,
  kind,
  type,
  included,
  ownLock,
  disabled,
  onToggle,
}: Pick<ChangeRowData, "id" | "name" | "folder" | "kind" | "type"> & {
  included: boolean;
  ownLock: boolean;
  disabled: boolean;
  onToggle: (id: string, included: boolean) => void;
}) {
  return (
    <li
      className="flex min-h-[var(--chrome-row,28px)] items-center gap-2 px-2 text-sm"
      data-testid={`changes-row-${id}`}
      data-change-kind={kind}
    >
      <Checkbox
        aria-label={`Include ${name}`}
        checked={included}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle(id, checked === true)}
      />
      <RowIcon type={type} />
      <span className="truncate">{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{folder}</span>
      {ownLock ? <LockIcon className="size-3.5 shrink-0 text-muted-foreground" role="img" aria-label="Locked By You" /> : null}
      <span className={cn("w-3.5 shrink-0 text-center text-xs font-bold", KIND_CLASS[kind])} title={KIND_LABEL[kind]}>
        {KIND_LETTER[kind]}
      </span>
    </li>
  );
});

function IncomingRow({ commit, now }: { commit: CommitInfo; now: number }) {
  const subject = commit.message.split("\n")[0]!.trim();
  return (
    <li className="flex min-h-[var(--chrome-row,28px)] items-center gap-2 px-2 text-sm" data-testid={`changes-incoming-${commit.id}`}>
      <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{subject}</span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
        {commit.author.name} · {agoLabel(commit.timestamp * 1000, now)}
      </span>
    </li>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[var(--chrome-row,28px)] items-center gap-1.5 px-2 text-xs font-semibold text-muted-foreground">{children}</div>;
}

/**
 * The Source Control tab's Changes window (Integrated mode): branch, Pull and
 * Push with their counts, the status line, changed assets with an include
 * checkbox each, the incoming commits, and the commit box.
 */
export function ChangesPanelContents() {
  const sync = useIntegratedSync();
  const snapshot = useIntegratedSyncState();
  const { sourceControl } = useSourceControl();
  const actions = useSourceControlActions();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [pushAfter, setPushAfter] = useState(true);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const now = Date.now();
  const busy = snapshot.operation !== null && snapshot.operation.kind !== "fetch";
  const rows = snapshot.rows;
  const included = useMemo(() => rows.filter((row) => !excluded.has(row.id)), [excluded, rows]);
  const allIncluded = rows.length > 0 && included.length === rows.length;
  const transfer = transferLabel(snapshot);

  // Commit… from the status bar or More Tools.
  const handledCommitRequest = useRef(actions.commitRequest);
  useEffect(() => {
    if (actions.commitRequest === handledCommitRequest.current) return;
    handledCommitRequest.current = actions.commitRequest;
    messageRef.current?.focus();
  }, [actions.commitRequest]);

  const toggle = useCallback((id: string, include: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (snapshot.blocked) {
    return (
      <PanelFrame data-testid="changes-panel">
        <p className="p-2 text-sm text-muted-foreground" data-testid="changes-blocked">
          {integratedBlockerLabel(snapshot.blocked)}
        </p>
      </PanelFrame>
    );
  }
  if (!snapshot.active) {
    return (
      <PanelFrame data-testid="changes-panel">
        <p className="p-2 text-sm text-muted-foreground">Opening The Repository…</p>
      </PanelFrame>
    );
  }

  const commit = async () => {
    const chosen = new Set(included.map((row) => row.id));
    if (await sync.commit({ rowIds: chosen, message: message.trim(), push: pushAfter })) {
      setMessage("");
      setExcluded(new Set());
    }
  };
  const problem = snapshot.problem;

  return (
    <PanelFrame data-testid="changes-panel">
      {/* A column as tall as the window, so the commit box sits at its foot. */}
      <div className="flex min-h-full flex-col">
        <div className="flex flex-col gap-1 p-2">
          <div className="flex items-center gap-1">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium" data-testid="changes-branch">
              <GitBranchIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{snapshot.branch}</span>
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              title="Refresh"
              data-testid="changes-refresh"
              disabled={busy || snapshot.operation?.kind === "fetch"}
              onClick={() => void actions.refresh()}
            >
              <RefreshCwIcon />
            </Button>
            <Button variant="outline" size="sm" data-testid="changes-pull" disabled={busy} onClick={actions.requestPull}>
              <ArrowDownToLineIcon data-icon="inline-start" />
              Pull
              {snapshot.behind > 0 ? <Badge variant="secondary">{snapshot.behind}</Badge> : null}
            </Button>
            <Button variant="outline" size="sm" data-testid="changes-push" disabled={busy || snapshot.ahead === 0} onClick={() => void actions.push()}>
              <ArrowUpFromLineIcon data-icon="inline-start" />
              Push
              {snapshot.ahead > 0 ? <Badge variant="secondary">{snapshot.ahead}</Badge> : null}
            </Button>
          </div>
          <p role="status" className="truncate text-xs text-muted-foreground" data-testid="changes-status">
            {transfer ?? syncStatusLine(snapshot, now)}
          </p>
        </div>
        {problem ? (
          <Alert variant="destructive" className="mx-2 mb-2 w-auto" data-testid="changes-problem">
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.message}</AlertDescription>
            {problem.code === "missing-lfs-rule" ? (
              <AlertAction>
                <Button size="sm" variant="outline" data-testid="changes-add-lfs-rule" disabled={busy} onClick={() => void sync.addLfsRule()}>
                  Add Git LFS Rule
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}
        <SectionHeading>
          <Checkbox
            aria-label="Include All Changes"
            checked={allIncluded}
            indeterminate={included.length > 0 && !allIncluded}
            disabled={rows.length === 0 || busy}
            onCheckedChange={(checked) => setExcluded(checked === true ? new Set() : new Set(rows.map((row) => row.id)))}
            data-testid="changes-include-all"
          />
          Changes
          <Badge variant="secondary" data-testid="changes-count">{rows.length}</Badge>
        </SectionHeading>
        {rows.length === 0 ? (
          <p className="px-2 pb-1 text-sm text-muted-foreground" data-testid="changes-empty">
            {snapshot.statusReady ? "No Changes." : "Reading Changes…"}
          </p>
        ) : (
          <ul className="flex flex-col" data-testid="changes-list">
            {rows.map((row) => (
              <ChangeRow
                key={row.id}
                id={row.id}
                name={row.name}
                folder={row.folder}
                kind={row.kind}
                type={row.type}
                included={!excluded.has(row.id)}
                ownLock={sourceControl.lockStateForPath(row.id) === "mine"}
                disabled={busy}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
        {snapshot.incoming.length > 0 ? (
          <>
            <SectionHeading>
              Incoming
              <Badge variant="secondary" data-testid="changes-incoming-count">{snapshot.behind}</Badge>
            </SectionHeading>
            <ul className="flex flex-col" data-testid="changes-incoming">
              {snapshot.incoming.map((commit) => <IncomingRow key={commit.id} commit={commit} now={now} />)}
            </ul>
          </>
        ) : null}
        <div className="mt-auto flex flex-col gap-2 border-t border-border p-2">
          <Field>
            <FieldLabel htmlFor="changes-commit-message">Commit Message</FieldLabel>
            <Textarea
              id="changes-commit-message"
              ref={messageRef}
              rows={3}
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              data-testid="changes-commit-message"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox
              id="changes-push-after"
              checked={pushAfter}
              onCheckedChange={(checked) => setPushAfter(checked === true)}
              data-testid="changes-push-after"
            />
            <Label htmlFor="changes-push-after" className="text-sm font-normal">Push After Commit</Label>
            <span className="flex-1" />
            <Button
              size="sm"
              data-testid="changes-commit"
              disabled={busy || included.length === 0 || message.trim() === ""}
              onClick={() => void commit()}
            >
              <CheckIcon data-icon="inline-start" />
              Commit {included.length} {included.length === 1 ? "Asset" : "Assets"}
            </Button>
          </div>
        </div>
      </div>
    </PanelFrame>
  );
}

export function ChangesPanel(_props: IDockviewPanelProps) {
  void _props;
  return <ChangesPanelContents />;
}

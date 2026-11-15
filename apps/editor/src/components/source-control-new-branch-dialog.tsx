import { useEffect, useState, useSyncExternalStore } from "react";
import { CircleAlertIcon, GitBranchPlusIcon } from "lucide-react";
import { isValidBranchName } from "@haptic/source-control";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { useDocumentActions, useIntegratedSync, useIntegratedSyncState } from "../context/document-context";

/** While documents are held read-only (a pull, switch or revert in progress, Play), why no branch is created now. */
function heldReason(reason: string | null): string {
  return `${(reason ?? "Documents are read-only right now").replace(/\.$/, "")}. Create the branch once that has finished.`;
}

/** Why Create Branch is disabled, or null. */
function refusal(name: string, local: readonly string[], remote: readonly string[]): string | null {
  if (name === "") return "Enter a branch name.";
  if (!isValidBranchName(name)) return "Branch names have no spaces or ~ ^ : ? * [ \\ and do not start with a dash.";
  if (local.includes(name)) return `There is already a branch named ${name}.`;
  if (remote.includes(name)) return `The remote already has a branch named ${name}. Switch to it instead.`;
  return null;
}

/**
 * New Branch…: a name, then the branch starts at the current commit and is
 * checked out. No file changes, so nothing is saved or reloaded first; the
 * next push creates it on the remote. Names this copy or the remote already
 * has are refused as they are typed (the remote's list only when it could be
 * read). Refused, saying why, while documents are held read-only: a branch
 * checked out under a pull's conflicts would make **Apply And Finish Pull**
 * pull the new branch instead.
 */
export default function NewBranchDialog({ onDone }: { onDone: () => void }) {
  const sync = useIntegratedSync();
  const { branch } = useIntegratedSyncState();
  const { getAuthoringLock, subscribeAuthoringLock } = useDocumentActions();
  const authoring = useSyncExternalStore(subscribeAuthoringLock, getAuthoringLock);
  const [name, setName] = useState("");
  const [local, setLocal] = useState<readonly string[]>([]);
  const [remote, setRemote] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void sync.localBranches().then((list) => {
      if (alive) setLocal(list);
    }, () => undefined);
    // A remote that cannot be reached refuses nothing here; the push says so later.
    void sync.remoteBranches(controller.signal).then((list) => {
      if (alive) setRemote(list);
    }, () => undefined);
    return () => {
      alive = false;
      controller.abort();
    };
  }, [sync]);

  const trimmed = name.trim();
  const nameReason = refusal(trimmed, local, remote);
  const reason = authoring.readOnly ? heldReason(authoring.reason) : nameReason;
  const invalid = (trimmed !== "" && nameReason !== null) || undefined;

  const create = async () => {
    // A hold that started since the last render (a pull from the status bar) refuses it too.
    if (getAuthoringLock().readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await sync.createBranch(trimmed);
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent className="sm:max-w-md" data-testid="source-control-new-branch">
        <DialogHeader>
          <DialogTitle>New Branch</DialogTitle>
          <DialogDescription>
            It starts at your current commit on {branch}, keeps your uncommitted changes and becomes your branch. Your next push creates it on the remote.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason && !busy) void create();
          }}
        >
          <FieldGroup className="gap-3">
            <Field orientation="horizontal" data-invalid={invalid}>
              <FieldLabel htmlFor="source-control-new-branch-name">Name</FieldLabel>
              <Input
                id="source-control-new-branch-name"
                value={name}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid}
                onChange={(event) => setName(event.target.value)}
                data-testid="source-control-new-branch-name"
              />
            </Field>
            {error ? (
              <Alert variant="destructive" data-testid="source-control-new-branch-error">
                <AlertTitle>Could Not Create The Branch</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter className="items-center">
            {reason ? (
              <span role="status" className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="source-control-new-branch-reason">
                <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{reason}</span>
              </span>
            ) : null}
            <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
            <Button type="submit" disabled={busy || reason !== null} data-testid="source-control-new-branch-create">
              <GitBranchPlusIcon data-icon="inline-start" />
              Create Branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { GitBranchIcon } from "lucide-react";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@haptic/ui/components/dropdown-menu";
import { useIntegratedSync, useIntegratedSyncState } from "../context/document-context";
import { useSourceControlActions } from "./source-control-actions";

/**
 * The branches to switch to, inside a dropdown menu (Changes' branch picker,
 * the status bar's **Switch Branch**, More Tools): this copy's branches with
 * the checked-out one marked, then the remote's other branches. Both lists
 * are read when the menu opens; the remote's (one request) may fail while
 * this copy's still show. Choosing one runs the Switch Branch flow.
 */
export function BranchMenuItems({ testId }: { testId: string }) {
  const sync = useIntegratedSync();
  const { branch, operation } = useIntegratedSyncState();
  const { requestSwitchBranch } = useSourceControlActions();
  const [local, setLocal] = useState<readonly string[] | null>(null);
  const [remote, setRemote] = useState<readonly string[] | "failed" | null>(null);

  // Mounted with the open menu, so each opening reads the lists afresh.
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    sync.localBranches().then((list) => {
      if (alive) setLocal(list);
    }, () => {
      if (alive) setLocal([]);
    });
    sync.remoteBranches(controller.signal).then((list) => {
      if (alive) setRemote(list);
    }, () => {
      if (alive) setRemote("failed");
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [sync]);

  const busy = operation !== null && operation.kind !== "fetch";
  // The checked-out branch is listed before its first commit too, when Git lists no ref for it.
  const ours = [...new Set([branch, ...(local ?? [])])].sort();
  const theirs = Array.isArray(remote) ? remote.filter((name) => !ours.includes(name)) : [];
  const choose = (name: string) => {
    if (name !== branch) requestSwitchBranch(name);
  };

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={branch} onValueChange={(value: string) => choose(value)}>
          {ours.map((name) => (
            <DropdownMenuRadioItem key={name} value={name} closeOnClick disabled={busy && name !== branch} data-testid={`${testId}-branch-${name}`}>
              <GitBranchIcon aria-hidden="true" />
              <span className="truncate">{name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Remote Branches</DropdownMenuLabel>
        {remote === null ? <DropdownMenuItem disabled>Reading Branches…</DropdownMenuItem> : null}
        {remote === "failed" ? <DropdownMenuItem disabled data-testid={`${testId}-remote-failed`}>Could Not Read Remote Branches</DropdownMenuItem> : null}
        {Array.isArray(remote) && theirs.length === 0 ? <DropdownMenuItem disabled>No Other Branches</DropdownMenuItem> : null}
        {theirs.map((name) => (
          <DropdownMenuItem key={name} disabled={busy} onClick={() => choose(name)} data-testid={`${testId}-remote-${name}`}>
            <GitBranchIcon aria-hidden="true" />
            <span className="truncate">{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </>
  );
}

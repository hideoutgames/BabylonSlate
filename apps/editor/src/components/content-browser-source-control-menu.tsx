import { GitCommitHorizontalIcon, GitCompareIcon, HistoryIcon, LockIcon, LockKeyholeOpenIcon, LockOpenIcon, Undo2Icon } from "lucide-react";
import type { ContextMenuItem } from "@haptic/editor-kit";
import type { FileLock } from "@haptic/source-control";
import type { ChangeRow } from "../lib/source-control-changes";
import { HEAD } from "../services/source-control-diff";
import type { SourceControlService } from "../services/source-control-service";
import type { SyncSnapshot } from "../services/source-control-sync";
import type { SourceControlActions } from "./source-control-actions";
import { LockBadge, lockHolderLabel } from "./source-control-markers";

/** An asset the Source Control menu acts on. */
export interface SourceControlMenuAsset {
  path: string;
  name: string;
  type: string;
}

/** What the menu reads as it opens, and the lock actions the Content Browser runs. */
export interface SourceControlMenuState {
  sourceControl: Pick<SourceControlService, "active" | "mode" | "enabled" | "lockingUnsupported" | "lockStateForPath" | "lockForPath">;
  /** Integrated mode's sync snapshot. */
  sync: Pick<SyncSnapshot, "active" | "rows" | "head">;
  /** The editor route's shared actions; without them the Integrated items are left out. */
  actions: Pick<SourceControlActions, "openDiff" | "openHistory" | "requestRevert"> | null;
  lock: (paths: string[]) => void;
  release: (paths: string[]) => void;
  /** Asks before removing someone else's lock, as the Locks window does. */
  forceUnlock: (lock: FileLock) => void;
}

/**
 * The asset menu's **Source Control** submenu, built as the menu opens, while
 * the project's mode is not Off: who holds a lone asset's lock, then **Lock**
 * (assets nobody holds), **Release Lock** (ours) and **Force Unlock…**
 * (someone else's, one asset), enabled while locks are live; in Integrated
 * mode, for one asset, **Show Changes** (its diff against the last commit),
 * **Show History** and **Revert…** (back to the last commit, through the
 * Revert flow), each enabled when the sync is running and, for Show Changes
 * and Revert, when the asset has a change. Several assets get only Lock and
 * Release Lock. Null while Source Control is Off or nothing is chosen.
 */
export function contentBrowserSourceControlMenu(
  assets: readonly SourceControlMenuAsset[],
  state: SourceControlMenuState,
): ContextMenuItem | null {
  const { sourceControl, sync, actions } = state;
  if (!sourceControl.active || assets.length === 0) return null;
  const live = sourceControl.enabled && !sourceControl.lockingUnsupported;
  const locked = assets.map((asset) => ({ asset, state: sourceControl.lockStateForPath(asset.path) }));
  const single = assets.length === 1 ? assets[0]! : null;
  const singleLock = single ? sourceControl.lockForPath(single.path) : undefined;
  const singleState = locked.length === 1 ? locked[0]!.state : null;
  const items: ContextMenuItem[] = [];

  if (single && singleState) {
    items.push(
      {
        type: "label",
        id: "source-control-holder",
        label: lockHolderLabel(singleState, singleLock?.ownerName),
        icon: <LockBadge state={singleState} ownerName={singleLock?.ownerName} size="sm" />,
      },
      { type: "separator", id: "source-control-holder-separator" },
    );
  }
  const unlocked = locked.filter((entry) => entry.state === null).map((entry) => entry.asset.path);
  const mine = locked.filter((entry) => entry.state === "mine").map((entry) => entry.asset.path);
  if (unlocked.length > 0) {
    items.push({ id: "source-control-lock", label: "Lock", icon: <LockIcon />, disabled: !live, onSelect: () => state.lock(unlocked) });
  }
  if (mine.length > 0) {
    items.push({ id: "source-control-release-lock", label: "Release Lock", icon: <LockOpenIcon />, disabled: !live, onSelect: () => state.release(mine) });
  }
  if (singleState === "theirs" && singleLock) {
    items.push({
      id: "source-control-force-unlock",
      label: "Force Unlock…",
      icon: <LockKeyholeOpenIcon />,
      variant: "destructive",
      disabled: !live,
      onSelect: () => state.forceUnlock(singleLock),
    });
  }

  if (single && actions && sourceControl.mode === "integrated") {
    const change: ChangeRow | undefined = sync.rows.find((row) => row.id === single.path);
    if (items.length > 0) items.push({ type: "separator", id: "source-control-integrated-separator" });
    items.push(
      {
        id: "source-control-show-changes",
        label: "Show Changes",
        icon: <GitCompareIcon />,
        disabled: !sync.active || !change,
        onSelect: () => actions.openDiff({ path: single.path, name: single.name, type: single.type }),
      },
      {
        id: "source-control-show-history",
        label: "Show History",
        icon: <HistoryIcon />,
        disabled: !sync.active,
        onSelect: () => actions.openHistory(single.path),
      },
      {
        id: "source-control-revert",
        label: "Revert…",
        icon: <Undo2Icon />,
        // HEAD's version goes back in; before the first commit there is none.
        disabled: !sync.active || !change || sync.head === null,
        onSelect: () => actions.requestRevert({ path: single.path, name: single.name, ref: HEAD }),
      },
    );
  }

  return { type: "submenu", id: "source-control", label: "Source Control", icon: <GitCommitHorizontalIcon />, items };
}

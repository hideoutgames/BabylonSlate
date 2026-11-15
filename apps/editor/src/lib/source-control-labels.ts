import type { SyncSnapshot } from "../services/source-control-sync";

/** `1 Commit`, `3 Commits`. */
export function commitsLabel(count: number): string {
  return `${count} ${count === 1 ? "Commit" : "Commits"}`;
}

/** `1 Change`, `4 Changes`. */
export function changesLabel(count: number): string {
  return `${count} ${count === 1 ? "Change" : "Changes"}`;
}

/** `just now`, `5 min ago`, `3 hr ago`, `2 days ago`, for status sentences. */
export function agoLabel(thenMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The Changes window's status line: what there is to pull and push, and when
 * the remote was last checked.
 */
export function syncStatusLine(snapshot: Pick<SyncSnapshot, "ahead" | "behind" | "lastFetchAt" | "operation">, nowMs: number): string {
  if (snapshot.lastFetchAt === null) return snapshot.operation?.kind === "fetch" ? "Checking for changes…" : "Not checked yet.";
  const { ahead, behind } = snapshot;
  const counts = behind > 0 && ahead > 0
    ? `${behind} ${behind === 1 ? "commit" : "commits"} to pull and ${ahead} to push.`
    : behind > 0
      ? `${behind} ${behind === 1 ? "commit" : "commits"} to pull.`
      : ahead > 0
        ? `${ahead} ${ahead === 1 ? "commit" : "commits"} to push.`
        : "Up to date.";
  return `${counts} Checked ${agoLabel(snapshot.lastFetchAt, nowMs)}.`;
}

/** `12.4 MB`, `640 KB`, for transfer progress and the Publish summary. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The running transfer with its `bytes` so far, as the status bar and the Changes window name it. */
export function transferLabel(snapshot: Pick<SyncSnapshot, "operation" | "ahead" | "behind">, transferred: number): string | null {
  const operation = snapshot.operation;
  if (!operation) return null;
  const bytes = transferred > 0 ? ` · ${bytesLabel(transferred)}` : "";
  if (operation.kind === "push") return `Pushing ${commitsLabel(snapshot.ahead)}${bytes}`;
  if (operation.kind === "pull") return `Pulling ${commitsLabel(snapshot.behind)}${bytes}`;
  if (operation.kind === "publish") return `Publishing${bytes}`;
  if (operation.kind === "commit") return "Committing";
  return null;
}

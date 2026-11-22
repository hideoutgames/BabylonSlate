import type { BlobReclaimResult } from "../services/project-service";

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a run did, as the row's status. */
export function projectStorageCleanupStatus(result: BlobReclaimResult): string {
  switch (result.status) {
    case "reclaimed":
      if (result.stopped) {
        return result.files > 0
          ? `Removed ${result.files} ${result.files === 1 ? "file" : "files"} (${megabytes(result.bytes)}). The project changed meanwhile, so some may remain: try again.`
          : "The project changed meanwhile, so nothing was removed. Try again.";
      }
      return result.files > 0 ? `Removed ${result.files} ${result.files === 1 ? "file" : "files"} (${megabytes(result.bytes)}).` : "Nothing to remove.";
    case "source-control":
      return "Source control manages this project's storage. Use Remove Unused Files in the Source Control tab.";
    case "incomplete":
      return `Nothing was removed: ${result.unreadable.length === 1 ? "an asset" : `${result.unreadable.length} assets`} could not be read (${result.unreadable.slice(0, 3).join(", ")}${result.unreadable.length > 3 ? ", …" : ""}).`;
    case "linked":
      return "Nothing was removed: a linked folder may share stored data with another folder.";
    case "no-project":
      return "No project is open.";
  }
}

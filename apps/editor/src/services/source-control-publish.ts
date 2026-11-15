import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import { GITIGNORE_ENTRIES, withIgnoreEntries, withLfsRule } from "@haptic/source-control";
import type { PublishSummary } from "../context/document-context-types";

// Publish's file work, loaded with the Publish dialog: the summary of what it
// pushes and the `.gitattributes` and `.gitignore` it writes.

const BLOB_PATH = /(?:^|\/)\.blobs\/[0-9a-f]{64}$/;
const CREATION_MARKER = ".haptic-creating";

/** `.gitignore`'s Publish entries as name globs (`*` within a name). */
const IGNORED = GITIGNORE_ENTRIES.map((entry) => new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));

async function readOptionalText(storage: ProjectStorage, path: string): Promise<string> {
  try {
    return await storage.readText(path);
  } catch (error) {
    if (isStorageNotFound(error)) return "";
    throw error;
  }
}

/**
 * What the first push sends: every file but `.git`, the ignored ones and the
 * creation marker, read from directory listings (sizes from stat only where
 * a listing has none). Assets are `.hasset` files; `.blobs` files go through
 * Git LFS.
 */
export async function summarizeProject(storage: ProjectStorage): Promise<PublishSummary> {
  const summary: PublishSummary = { assets: 0, bytes: 0, lfsBytes: 0 };
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await storage.readdir(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (path === ".git" || path === CREATION_MARKER || IGNORED.some((rule) => rule.test(entry.name))) continue;
      if (entry.isDir) {
        await walk(path);
        continue;
      }
      const size = entry.size ?? (await storage.stat(path)).size ?? 0;
      summary.bytes += size;
      if (BLOB_PATH.test(path)) summary.lfsBytes += size;
      else if (path.endsWith(".hasset")) summary.assets += 1;
    }
  };
  await walk("");
  return summary;
}

/** Adds the `.blobs` LFS rule to `.gitattributes` and the Publish entries to `.gitignore`, keeping what they hold. */
export async function writePublishFiles(storage: ProjectStorage): Promise<void> {
  await storage.writeText(".gitattributes", withLfsRule(await readOptionalText(storage, ".gitattributes")));
  await storage.writeText(".gitignore", withIgnoreEntries(await readOptionalText(storage, ".gitignore")));
}

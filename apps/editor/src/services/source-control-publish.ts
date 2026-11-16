import { isOk, isStorageNotFound, PROJECT_CREATION_MARKER, type ProjectStorage, type SourceControlProjectSettings } from "@haptic/core";
import { GITIGNORE_ENTRIES, lfsObjectId, withIgnoreEntries, withLfsRule } from "@haptic/source-control";
import { hostApiFor, type HostApi, type HostOwner } from "@haptic/source-control/host-api";
import type { PublishSummary } from "../context/document-context-types";
import { canPublishProject, publishReplacesRepository } from "../lib/source-control-mode";
import { sourceControlAccounts } from "./source-control-accounts";
import type { SourceControlSyncService, SyncConfigureInput } from "./source-control-sync";

// Publish's work, loaded with the Publish dialog or a Remote New Project: the
// summary of what it pushes, the `.gitattributes` and `.gitignore` it writes,
// and the new repository it creates and publishes the open project to.

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
      if (path === ".git" || path === PROJECT_CREATION_MARKER || IGNORED.some((rule) => rule.test(entry.name))) continue;
      if (entry.isDir) {
        await walk(path);
        continue;
      }
      const size = entry.size ?? (await storage.stat(path)).size ?? 0;
      summary.bytes += size;
      if (lfsObjectId(path)) summary.lfsBytes += size;
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

/** A repository to create on a host this device is signed in to: Publish's and a Remote New Project's choice. */
export interface NewRepositoryRequest {
  /** The host account's origin (its credential's key on this device). */
  origin: string;
  owner: HostOwner;
  name: string;
  private: boolean;
}

/**
 * How publishing to a new repository ended. `local`: the project is still
 * Off, as before (no repository could be created, or Haptic could not start
 * its working copy). `integrated`: the project is Integrated with the new
 * repository, but its first commit or push did not finish; the sync snapshot
 * holds the problem and Push offers what is left.
 */
export type PublishOutcome =
  | { status: "published"; repositoryUrl: string }
  | { status: "local"; message: string }
  | { status: "integrated"; message: string };

/** The REST API for this device's credential on `origin`; null without one, or for a host Haptic has no API code for. */
export async function hostApiForOrigin(origin: string, testMode: boolean): Promise<HostApi | null> {
  const accounts = await sourceControlAccounts(testMode);
  const credential = (await accounts.list()).find((candidate) => candidate.origin === origin);
  return credential && accounts.http ? hostApiFor(credential, accounts.http, accounts.credentialSource(origin)) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish to a new repository, for the Publish dialog and a Remote New
 * Project alike: creates the empty repository (`HostApi.createRepository`,
 * which takes over an empty one an interrupted Publish left under the same
 * name), writes the Git files, makes the folder the repository's working
 * copy, saves Integrated mode through `saveSettings` and pushes the first
 * commit (`SourceControlSyncService.publish`). Nothing is created for a
 * project Publish does not apply to (`canPublishProject`). Never rejects:
 * the outcome says how far it got, and no project file is deleted.
 */
export async function publishToNewRepository({
  api,
  repository,
  sync,
  input,
  saveSettings,
}: {
  /** The host's API for `repository.origin`; null when this device is not signed in there. */
  api: HostApi | null;
  repository: NewRepositoryRequest;
  sync: SourceControlSyncService;
  /** The open project's sync input, with its settings as they are (Off). */
  input: SyncConfigureInput;
  saveSettings: (settings: SourceControlProjectSettings) => Promise<void>;
}): Promise<PublishOutcome> {
  if (!api) return { status: "local", message: `Sign in to ${new URL(repository.origin).host} to create the repository.` };
  const tier = input.folder?.tier ?? null;
  const hasGit = tier !== null && (await input.storage.exists(".git/HEAD").catch(() => false));
  const folder = { platform: input.platform, testMode: input.testMode, tier, hasGit };
  if (!canPublishProject(input.settings.mode, folder)) {
    return {
      status: "local",
      message: input.settings.mode === "off" ? "Haptic can't be this folder's Git app." : "This project already uses source control.",
    };
  }
  const created = await api.createRepository({ owner: repository.owner, name: repository.name, private: repository.private });
  if (!isOk(created)) return { status: "local", message: created.error.message };
  const { repositoryUrl, defaultBranch: branch } = created.value;
  let integrated = false;
  try {
    await writePublishFiles(input.storage);
    await sync.publish({
      input,
      repositoryUrl,
      branch,
      // The .git of an interrupted Publish (app storage on a device) is replaced; elsewhere init refuses one.
      replace: publishReplacesRepository(folder),
      // The first commit holds Integrated mode; the client is already open, so the mode change keeps it.
      beforeCommit: async () => {
        await saveSettings({ ...input.settings, mode: "integrated", repositoryUrl, branch });
        integrated = true;
      },
    });
    return { status: "published", repositoryUrl };
  } catch (error) {
    return { status: integrated ? "integrated" : "local", message: messageOf(error) };
  }
}

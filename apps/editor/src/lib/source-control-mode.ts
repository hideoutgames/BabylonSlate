import type { SourceControlMode, StorageTier } from "@haptic/core";
import { isSourceControlHost, parseRepositoryUrl, repositoryCloneUrl } from "@haptic/source-control";

/** Where the project's folder is and what it holds, as the mode rules need it. */
export interface SourceControlFolder {
  platform: string;
  testMode: boolean;
  /** Null while no project folder is bound. */
  tier: StorageTier | null;
  /** The folder has a readable `.git` (test mode's fake has none and needs none). */
  hasGit: boolean;
}

/**
 * Why Integrated mode cannot run Haptic's Git client in this folder, or null
 * when it can. `project.json` is committed, so a stored Integrated mode
 * arrives in folders where another Git client owns the working copy: one Git
 * client per folder. `unavailable`: this host has no source control.
 * `no-repository`: the folder has no `.git` (a copy that was not cloned or
 * published here). `other-git-client`: a chosen folder on iOS or Android,
 * which another app (Working Copy) syncs. `not-adopted`: a desktop working
 * copy whose user has not yet accepted Haptic as its Git client
 * (`asksAdoption`).
 */
export type IntegratedBlocker = "unavailable" | "no-repository" | "other-git-client" | "not-adopted";

/**
 * `adopted`: this device made Haptic the working copy's Git client (Clone or
 * Publish made it here, or its user accepted the one-Git-app warning); read
 * only where `asksAdoption` holds.
 */
export function integratedBlocker(folder: SourceControlFolder & { adopted: boolean }): IntegratedBlocker | null {
  if (!isSourceControlHost(folder.platform, folder.testMode)) return "unavailable";
  if (folder.testMode) return null;
  if (!folder.hasGit) return "no-repository";
  if (folder.tier === "external" && folder.platform !== "electron") return "other-git-client";
  if (asksAdoption(folder) && !folder.adopted) return "not-adopted";
  return null;
}

/**
 * Whether Haptic asks once before running Git in the folder: on desktop any
 * Git app (GitHub Desktop, the git CLI) may own a working copy, so a stored
 * Integrated mode waits for this device's answer, kept in the working copy's
 * own Git config. iOS and Android app storage has no other Git client (their
 * chosen folders are `other-git-client`), and test mode has no `.git`.
 */
export function asksAdoption(folder: SourceControlFolder): boolean {
  return folder.platform === "electron" && !folder.testMode && folder.hasGit;
}

/**
 * Project Settings → Source Control's Mode options, in display order. Off and
 * Manual are always offered. Integrated is offered for a project that already
 * uses it, and for a folder with a readable `.git` Haptic may run Git in: on
 * desktop any (it switches only after a warning that no other Git app may use
 * the folder at the same time), and on iOS and Android app storage, where
 * Haptic is the only Git client, so a working copy whose `project.json` left
 * Integrated mode (a branch that turns it off) is never stranded. Elsewhere
 * Integrated projects come from Clone or Publish.
 */
export function offeredSourceControlModes(stored: SourceControlMode, folder: SourceControlFolder): SourceControlMode[] {
  const repository = folder.hasGit && isSourceControlHost(folder.platform, folder.testMode)
    && (folder.platform === "electron" || (folder.tier !== null && folder.tier !== "external"));
  return stored === "integrated" || repository ? ["off", "integrated", "manual"] : ["off", "manual"];
}

/**
 * Publish turns an Off project into an Integrated one: a host with source
 * control, a folder with no Git repository yet (or one only an interrupted
 * Publish left, see `publishReplacesRepository`), and one Haptic may be the
 * Git client of (app storage, or any folder on desktop).
 */
export function canPublishProject(stored: SourceControlMode, folder: SourceControlFolder): boolean {
  if (stored !== "off" || folder.tier === null) return false;
  if (!isSourceControlHost(folder.platform, folder.testMode)) return false;
  if (folder.hasGit) return publishReplacesRepository(folder);
  return folder.testMode || folder.tier !== "external" || folder.platform === "electron";
}

/**
 * Whether Publish replaces the folder's `.git`. In app storage on iOS and
 * Android only Haptic runs Git, so a `.git` in a project whose mode is still
 * Off is what an interrupted Publish left (it saves Integrated mode only after
 * creating `.git`). On desktop any Git app may have made it: Mode offers
 * Integrated for it instead, and nothing is deleted.
 */
export function publishReplacesRepository(folder: SourceControlFolder): boolean {
  return folder.hasGit && folder.tier !== null && folder.tier !== "external" && folder.platform !== "electron";
}

/** The label Project Settings and the Source Control tab show for a blocker. */
export function integratedBlockerLabel(blocker: IntegratedBlocker): string {
  if (blocker === "no-repository") return "This Folder Has No Git Repository";
  if (blocker === "other-git-client") return "Another Git App Syncs This Folder";
  if (blocker === "not-adopted") return "Haptic Does Not Run Git In This Folder Yet";
  return "Source Control Is Not Available Here";
}

const MODE_NAMES: Record<string, string> = { off: "Off", manual: "Manual" };

/**
 * Why a switch to `branch` is refused, or null: its committed `project.json`
 * (`projectJson`, null when it has none) must keep Integrated mode with the
 * same repository. The switch's reload installs that branch's settings, and
 * any other mode stops Haptic's Git client in this working copy, which on
 * iOS and Android may then have no way back.
 */
export function branchSettingsRefusal(branch: string, projectJson: Uint8Array | null, repositoryUrl: string): string | null {
  if (!projectJson) return `${branch} has no Haptic project: project.json is missing.`;
  let sourceControl: { mode?: unknown; repositoryUrl?: unknown } | undefined;
  try {
    sourceControl = (JSON.parse(new TextDecoder().decode(projectJson)) as { settings?: { sourceControl?: { mode?: unknown; repositoryUrl?: unknown } } } | null)?.settings?.sourceControl;
  } catch {
    return `${branch}'s project.json cannot be read.`;
  }
  const keepOn = "Only a branch in Integrated mode with this repository can be checked out here; change its Project Settings with another Git app first.";
  if (sourceControl?.mode !== "integrated") {
    return `${branch}'s Project Settings set Source Control to ${MODE_NAMES[String(sourceControl?.mode)] ?? "Off"}, so switching would stop Haptic's Git in this folder. ${keepOn}`;
  }
  const other = typeof sourceControl.repositoryUrl === "string" ? sourceControl.repositoryUrl : "";
  if (!sameRepository(other, repositoryUrl)) {
    return `${branch}'s Project Settings use another repository (${other || "none"}), so switching would stop Haptic's Git in this folder. ${keepOn}`;
  }
  return null;
}

/** Whether two repository URLs name the same repository (HTTPS, SSH or scp-style, with or without `.git`). */
export function sameRepository(a: string, b: string): boolean {
  const left = parseRepositoryUrl(a);
  const right = parseRepositoryUrl(b);
  return left && right ? repositoryCloneUrl(left) === repositoryCloneUrl(right) : a.trim() === b.trim();
}

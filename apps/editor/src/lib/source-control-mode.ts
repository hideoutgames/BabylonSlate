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
 * which another app (Working Copy) syncs.
 */
export type IntegratedBlocker = "unavailable" | "no-repository" | "other-git-client";

export function integratedBlocker(folder: SourceControlFolder): IntegratedBlocker | null {
  if (!isSourceControlHost(folder.platform, folder.testMode)) return "unavailable";
  if (folder.testMode) return null;
  if (!folder.hasGit) return "no-repository";
  if (folder.tier === "external" && folder.platform !== "electron") return "other-git-client";
  return null;
}

/**
 * Project Settings → Source Control's Mode options, in display order. Off and
 * Manual are always offered. Integrated is offered for a project that already
 * uses it, and on desktop for a folder with a readable `.git`, which then
 * switches only after a warning that no other Git app may use the folder at
 * the same time. Elsewhere Integrated projects come from Clone or Publish.
 */
export function offeredSourceControlModes(stored: SourceControlMode, folder: SourceControlFolder): SourceControlMode[] {
  const integrated = stored === "integrated" || (folder.platform === "electron" && folder.hasGit);
  return integrated ? ["off", "integrated", "manual"] : ["off", "manual"];
}

/**
 * Publish turns an Off project into an Integrated one: a host with source
 * control, a folder with no Git repository yet, and one Haptic may be the Git
 * client of (app storage, or any folder on desktop).
 */
export function canPublishProject(stored: SourceControlMode, folder: SourceControlFolder): boolean {
  if (stored !== "off" || folder.tier === null || folder.hasGit) return false;
  if (!isSourceControlHost(folder.platform, folder.testMode)) return false;
  return folder.testMode || folder.tier !== "external" || folder.platform === "electron";
}

/** The label Project Settings and the Source Control tab show for a blocker. */
export function integratedBlockerLabel(blocker: IntegratedBlocker): string {
  if (blocker === "no-repository") return "This Folder Has No Git Repository";
  if (blocker === "other-git-client") return "Another Git App Syncs This Folder";
  return "Source Control Is Not Available Here";
}

/** Whether two repository URLs name the same repository (HTTPS, SSH or scp-style, with or without `.git`). */
export function sameRepository(a: string, b: string): boolean {
  const left = parseRepositoryUrl(a);
  const right = parseRepositoryUrl(b);
  return left && right ? repositoryCloneUrl(left) === repositoryCloneUrl(right) : a.trim() === b.trim();
}

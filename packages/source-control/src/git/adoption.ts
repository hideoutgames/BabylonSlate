import * as git from "isomorphic-git";
import type { ProjectStorage } from "@haptic/core";
import { installBufferGlobal } from "./buffer-global";
import { GITDIR, StorageFs, WORKTREE } from "./storage-fs";

/**
 * The working copy's own Git config entry (`[haptic] integrated = true` in
 * `.git/config`) saying that this device made Haptic its Git client: per
 * working copy, never committed, and kept when Haptic is reinstalled. Clone
 * and Publish write it for the copies they make; on desktop the answer to the
 * one-Git-app warning writes or clears it.
 */
export const ADOPTION_CONFIG = "haptic.integrated";

/** Git's spellings of true for a boolean entry. */
const TRUE_VALUES = new Set(["true", "yes", "on", "1"]);

/** Whether the working copy in the folder `storage` is bound to is Haptic's; false without the entry or without `.git`. */
export async function readAdoption(storage: ProjectStorage): Promise<boolean> {
  installBufferGlobal();
  // isomorphic-git casts only `core` entries, so this one reads back as text.
  const value: unknown = await git.getConfig({ fs: new StorageFs(storage), dir: WORKTREE, gitdir: GITDIR, path: ADOPTION_CONFIG });
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/** Records or clears it, leaving the rest of the config as it is. */
export async function setAdoption(storage: ProjectStorage, adopted: boolean): Promise<void> {
  installBufferGlobal();
  await git.setConfig({ fs: new StorageFs(storage), dir: WORKTREE, gitdir: GITDIR, path: ADOPTION_CONFIG, value: adopted ? true : undefined });
}

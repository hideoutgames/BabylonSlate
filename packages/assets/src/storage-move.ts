import type { ProjectStorage } from "@babylonslate/core";
import { newAssetGuid } from "./guid";

/** Resolve the spelling on disk before deciding whether two existing paths alias. */
async function storedPath(storage: ProjectStorage, path: string): Promise<string> {
  let parent = "";
  for (const segment of path.split("/")) {
    const entries = await storage.readdir(parent || ".");
    const entry = entries.find((item) => item.name === segment) ??
      entries.find((item) => item.name.toLowerCase() === segment.toLowerCase());
    if (!entry) throw new Error(`File not found: ${path}`);
    parent = parent ? `${parent}/${entry.name}` : entry.name;
  }
  return parent;
}

async function targetAliasesSource(storage: ProjectStorage, from: string, to: string): Promise<boolean> {
  if (!(await storage.exists(to))) return false;
  if (await storedPath(storage, from) === await storedPath(storage, to)) return true;
  throw new Error(`Target path already exists: ${to}`);
}

function backupPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return `${slash < 0 ? "" : path.slice(0, slash + 1)}.babylonslate-move-${newAssetGuid()}`;
}

async function removeBackup(storage: ProjectStorage, path: string): Promise<void> {
  try { await storage.remove(path); } catch { /* A retained backup must not undo a successful move. */ }
}

/** Copy before removing the source, including empty directories and unindexed files. */
export async function copyStorageTree(storage: ProjectStorage, from: string, to: string): Promise<string[]> {
  const folders: string[] = [];
  async function walk(relative: string): Promise<void> {
    const source = relative ? `${from}/${relative}` : from;
    const destination = relative ? `${to}/${relative}` : to;
    const entries = await storage.readdir(source);
    await storage.mkdir(destination, true);
    folders.push(relative);
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDir) await walk(child);
      else await storage.writeBinary(`${to}/${child}`, await storage.readBinary(`${from}/${child}`));
    }
  }
  await walk("");
  return folders;
}

/** A portable case-only rename must first vacate the filesystem's existing spelling. */
export async function moveStorageFile(
  storage: ProjectStorage,
  from: string,
  to: string,
  original: Uint8Array,
  replacement = original,
): Promise<void> {
  const aliases = await targetAliasesSource(storage, from, to);
  const slash = to.lastIndexOf("/");
  const parent = slash < 0 ? "" : to.slice(0, slash);
  if (parent) await storage.mkdir(parent, true);
  if (!aliases) {
    await storage.writeBinary(to, replacement);
    // If removal fails, the complete destination remains available for recovery.
    await storage.remove(from);
    return;
  }
  const backup = backupPath(from);
  await storage.writeBinary(backup, original);
  try {
    await storage.remove(from);
    await storage.writeBinary(to, replacement);
  } catch (error) {
    try { await storage.writeBinary(from, original); }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], `Rename failed; the original is preserved at ${backup}`);
    }
    await removeBackup(storage, backup);
    throw error;
  }
  await removeBackup(storage, backup);
}

export async function moveStorageTree(storage: ProjectStorage, from: string, to: string): Promise<string[]> {
  const source = await storedPath(storage, from);
  let ancestor = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  while (ancestor && !(await storage.exists(ancestor))) {
    ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "";
  }
  if (ancestor) {
    const destinationParent = await storedPath(storage, ancestor);
    if (destinationParent === source || destinationParent.startsWith(`${source}/`)) {
      throw new Error("Cannot move a folder into itself");
    }
  }
  const aliases = await targetAliasesSource(storage, from, to);
  if (!aliases) {
    let folders: string[];
    try { folders = await copyStorageTree(storage, from, to); }
    catch (error) {
      await removeBackup(storage, to);
      throw error;
    }
    await storage.remove(from);
    return folders;
  }
  const backup = backupPath(from);
  let folders: string[];
  try { folders = await copyStorageTree(storage, from, backup); }
  catch (error) { await removeBackup(storage, backup); throw error; }
  try {
    await storage.remove(from);
    await copyStorageTree(storage, backup, to);
  } catch (error) {
    try {
      // A partial destination may still have the old spelling on this host.
      if (await storage.exists(to)) await storage.remove(to);
      await copyStorageTree(storage, backup, from);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Move failed; the original is preserved at ${backup}`);
    }
    await removeBackup(storage, backup);
    throw error;
  }
  await removeBackup(storage, backup);
  return folders;
}

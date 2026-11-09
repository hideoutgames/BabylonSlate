import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** File work the native game packagers share. */

/** A path under `root` for a package file, refusing anything that leaves it. */
export function within(root: string, path: string): string {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid game file path: ${path}`);
  }
  return join(root, ...path.split("/"));
}

/** Every file under `from` copied to `to`; reads through Electron's archive support when a template is packed. */
export async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await writeFile(join(to, entry.name), await readFile(join(from, entry.name)));
  }
}

/** Writes each `[path, bytes]` under `root`, making its folders. */
export async function writeFiles(root: string, files: Iterable<[string, Uint8Array]>): Promise<void> {
  for (const [path, data] of files) {
    const target = within(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

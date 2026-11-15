import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import type { CredentialSource } from "../credentials";
import type { HttpClient } from "../http";
import { sha256Hex } from "../lfs-pointer";
import { withLfsRule, type CommitAuthor } from "../sync-port";
import { cloneRepository, DEFAULT_CLONE_DEPTH, type GitRepository } from "./repository";

export interface GitBenchmarkOptions {
  /** An empty scratch project folder of its own; never the open project's storage. */
  storage: ProjectStorage;
  http: HttpClient;
  credential: CredentialSource;
  repositoryUrl: string;
  branch: string;
  /** A new remote branch the commits go to, so the measured branch is never changed. */
  remoteBranch: string;
  author: CommitAuthor;
  /** LFS objects written, uploaded and downloaded again (default 3 of 32 MiB). */
  blobs?: { count: number; size: number };
  depth?: number;
  /** Milliseconds for timings (default `performance.now`). */
  timer?: () => number;
}

export interface GitBenchmarkStep {
  ms: number;
  /** Bytes sent and received over HTTP (Git and LFS). */
  sent: number;
  received: number;
  /** Working tree files read in full; an unchanged status must read none. */
  workingReads: number;
}

export interface GitBenchmarkResult {
  /** Files in the clone, `.git` excluded. */
  files: number;
  /** Changes the unchanged status found (must be 0). */
  unchangedStatusChanges: number;
  clone: GitBenchmarkStep;
  status: GitBenchmarkStep;
  commit: GitBenchmarkStep;
  push: GitBenchmarkStep;
  lfsUpload: GitBenchmarkStep & { objects: number; bytes: number };
  lfsDownload: GitBenchmarkStep & { objects: number; bytes: number };
  /** What the run leaves on the host. */
  leftovers: string;
}

const MIB = 1024 * 1024;

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
  return bytes;
}

async function countFiles(storage: ProjectStorage, dir = ""): Promise<number> {
  let count = 0;
  for (const entry of await storage.readdir(dir)) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    count += entry.isDir ? await countFiles(storage, path) : 1;
  }
  return count;
}

async function readText(storage: ProjectStorage, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await storage.readBinary(path));
  } catch (error) {
    if (isStorageNotFound(error)) return "";
    throw error;
  }
}

/**
 * The iPad gate's measurement: a shallow clone, a status of the unchanged
 * tree (which must read no file), a one-file commit and its push, then a few
 * large LFS objects committed, uploaded and downloaded again. Commits go to
 * `remoteBranch` only; the caller deletes the scratch folder afterwards.
 */
export async function runGitBenchmark(options: GitBenchmarkOptions): Promise<GitBenchmarkResult> {
  const timer = options.timer ?? (() => performance.now());
  const { storage, author } = options;
  let repository: GitRepository | null = null;
  const step = async <T>(work: () => Promise<T>): Promise<[T, GitBenchmarkStep]> => {
    const start = timer();
    const value = await work();
    const counters = repository!.lastOperation;
    return [value, { ms: timer() - start, sent: counters.transfer.sent, received: counters.transfer.received, workingReads: counters.storage.workingReads }];
  };

  const cloneStart = timer();
  repository = await cloneRepository({
    storage,
    http: options.http,
    credential: options.credential,
    repositoryUrl: options.repositoryUrl,
    branch: options.branch,
    depth: options.depth ?? DEFAULT_CLONE_DEPTH,
  });
  const cloned = repository.lastOperation;
  const clone: GitBenchmarkStep = { ms: timer() - cloneStart, sent: cloned.transfer.sent, received: cloned.transfer.received, workingReads: cloned.storage.workingReads };
  const files = await countFiles(storage);

  const [status, statusStep] = await step(() => repository!.status());

  const marker = `haptic-benchmark/${options.remoteBranch}.txt`;
  await storage.writeBinary(marker, new TextEncoder().encode(`${options.remoteBranch}\n`));
  const [, commit] = await step(() => repository!.commit({ paths: [marker], message: "Haptic Git benchmark: one file", author }));
  const [, push] = await step(() => repository!.push({ remoteBranch: options.remoteBranch }));

  const { count, size } = options.blobs ?? { count: 3, size: 32 * MIB };
  const blobs: Array<{ path: string; bytes: Uint8Array }> = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(size);
    blobs.push({ path: `assets/.blobs/${await sha256Hex(bytes)}`, bytes });
  }
  for (const blob of blobs) await storage.writeBinary(blob.path, blob.bytes);
  const paths = blobs.map((blob) => blob.path);
  const attributes = await readText(storage, ".gitattributes");
  if (withLfsRule(attributes) !== attributes) {
    await storage.writeBinary(".gitattributes", new TextEncoder().encode(withLfsRule(attributes)));
    paths.push(".gitattributes");
  }
  const [{ commit: head }] = await step(() => repository!.commit({ paths, message: "Haptic Git benchmark: LFS objects", author }));
  const [pushed, lfsUpload] = await step(() => repository!.push({ remoteBranch: options.remoteBranch }));

  for (const blob of blobs) await storage.remove(blob.path);
  const downloadStart = timer();
  const download = { sent: 0, received: 0, workingReads: 0 };
  for (const blob of blobs) {
    const bytes = await repository.readFile(blob.path, head);
    if (!bytes || bytes.byteLength !== blob.bytes.byteLength) throw new Error(`LFS object ${blob.path} did not come back.`);
    download.sent += repository.lastOperation.transfer.sent;
    download.received += repository.lastOperation.transfer.received;
  }

  return {
    files,
    unchangedStatusChanges: status.changes.length,
    clone,
    status: statusStep,
    commit,
    push,
    lfsUpload: { ...lfsUpload, objects: pushed.uploaded, bytes: count * size },
    lfsDownload: { ms: timer() - downloadStart, ...download, objects: count, bytes: count * size },
    leftovers: `Branch ${options.remoteBranch} (two commits) and ${count} LFS objects of ${size} bytes on the host; delete the branch there. LFS storage is freed only as the host allows.`,
  };
}

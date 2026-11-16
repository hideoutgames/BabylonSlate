import { isStorageNotFound, type ProjectStorage } from "@haptic/core";
import type { CredentialSource } from "../credentials";
import type { FileTransferClient, HttpClient } from "../http";
import { sha256Hex } from "../lfs-pointer";
import { withLfsRule, type CommitAuthor } from "../sync-port";
import { cloneRepository, DEFAULT_CLONE_DEPTH, type GitRepository } from "./repository";

/** The benchmark's stages in order; the runner records each before it starts, so a run the app did not survive names where it stopped. */
export const GIT_BENCHMARK_STAGES = [
  "clone",
  "status",
  "commit",
  "push",
  "create-objects",
  "lfs-commit",
  "lfs-upload",
  "lfs-download",
] as const;

export type GitBenchmarkStage = (typeof GIT_BENCHMARK_STAGES)[number];

export interface GitBenchmarkOptions {
  /** An empty scratch project folder of its own; never the open project's storage. */
  storage: ProjectStorage;
  http: HttpClient;
  /**
   * The host's native file transfer, bound to `storage`'s folder: the LFS
   * objects then stream between the server and their files. Without one
   * they cross whole through `http`, as on hosts that have none.
   */
  files?: FileTransferClient;
  /**
   * Writes `size` random bytes into a new file of `directory` (which exists),
   * named by their SHA-256, without building them in JavaScript (the native
   * side generates them). Without it each object is made in JavaScript and
   * written before the next one is made.
   */
  writeRandomObject?: (directory: string, size: number) => Promise<{ path: string; sha256: string }>;
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
  /** Awaited before each stage starts (`GIT_BENCHMARK_STAGES`, in order). */
  onStage?: (stage: GitBenchmarkStage) => Promise<void> | void;
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
  /** How LFS objects moved: streamed by the host between server and file, or as whole bodies through JavaScript. */
  transfer: "native" | "whole-body";
  /** Files in the clone, `.git` excluded. */
  files: number;
  /** Changes the unchanged status found (must be 0). */
  unchangedStatusChanges: number;
  clone: GitBenchmarkStep;
  status: GitBenchmarkStep;
  commit: GitBenchmarkStep;
  push: GitBenchmarkStep;
  /** Making the LFS objects, one at a time (no network). */
  createObjects: { ms: number; objects: number; bytes: number };
  lfsCommit: GitBenchmarkStep;
  lfsUpload: GitBenchmarkStep & { objects: number; bytes: number };
  lfsDownload: GitBenchmarkStep & { objects: number; bytes: number };
  /** What the run leaves on the host. */
  leftovers: string;
}

const MIB = 1024 * 1024;
/** Where the objects go: the project content root's blob folder. */
const BLOB_FOLDER = "assets/.blobs";

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
 * large LFS objects made, committed, uploaded and downloaded again into
 * their files. Commits go to `remoteBranch` only; the caller deletes the
 * scratch folder afterwards. JavaScript never holds more than one object, and
 * none at all when the host makes the objects and transfers them itself.
 */
export async function runGitBenchmark(options: GitBenchmarkOptions): Promise<GitBenchmarkResult> {
  const timer = options.timer ?? (() => performance.now());
  const { storage, author } = options;
  const stage = async (name: GitBenchmarkStage) => options.onStage?.(name);
  let repository: GitRepository | null = null;
  const step = async <T>(work: () => Promise<T>): Promise<[T, GitBenchmarkStep]> => {
    const start = timer();
    const value = await work();
    const counters = repository!.lastOperation;
    return [value, { ms: timer() - start, sent: counters.transfer.sent, received: counters.transfer.received, workingReads: counters.storage.workingReads }];
  };

  await stage("clone");
  const cloneStart = timer();
  repository = await cloneRepository({
    storage,
    http: options.http,
    ...(options.files ? { files: options.files } : {}),
    credential: options.credential,
    repositoryUrl: options.repositoryUrl,
    branch: options.branch,
    depth: options.depth ?? DEFAULT_CLONE_DEPTH,
  });
  const cloned = repository.lastOperation;
  const clone: GitBenchmarkStep = { ms: timer() - cloneStart, sent: cloned.transfer.sent, received: cloned.transfer.received, workingReads: cloned.storage.workingReads };
  const files = await countFiles(storage);

  await stage("status");
  const [status, statusStep] = await step(() => repository!.status());

  await stage("commit");
  const marker = `haptic-benchmark/${options.remoteBranch}.txt`;
  await storage.writeBinary(marker, new TextEncoder().encode(`${options.remoteBranch}\n`));
  const [, commit] = await step(() => repository!.commit({ paths: [marker], message: "Haptic Git benchmark: one file", author }));
  await stage("push");
  const [, push] = await step(() => repository!.push({ remoteBranch: options.remoteBranch }));

  await stage("create-objects");
  const { count, size } = options.blobs ?? { count: 3, size: 32 * MIB };
  const createStart = timer();
  await storage.mkdir(BLOB_FOLDER, true);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (options.writeRandomObject) {
      paths.push((await options.writeRandomObject(BLOB_FOLDER, size)).path);
      continue;
    }
    // One object in memory at a time: written, then let go before the next is made.
    const bytes = randomBytes(size);
    const path = `${BLOB_FOLDER}/${await sha256Hex(bytes)}`;
    await storage.writeBinary(path, bytes);
    paths.push(path);
  }
  const createObjects = { ms: timer() - createStart, objects: count, bytes: count * size };

  await stage("lfs-commit");
  const committed = [...paths];
  const attributes = await readText(storage, ".gitattributes");
  if (withLfsRule(attributes) !== attributes) {
    await storage.writeBinary(".gitattributes", new TextEncoder().encode(withLfsRule(attributes)));
    committed.push(".gitattributes");
  }
  const [{ commit: head }, lfsCommit] = await step(() => repository!.commit({ paths: committed, message: "Haptic Git benchmark: LFS objects", author }));
  await stage("lfs-upload");
  const [pushed, lfsUpload] = await step(() => repository!.push({ remoteBranch: options.remoteBranch }));

  await stage("lfs-download");
  for (const path of paths) await storage.remove(path);
  const [, lfsDownload] = await step(() => repository!.downloadLfsObjects(head, paths));
  for (const path of paths) {
    const stat = await storage.stat(path).catch(() => null);
    if (stat?.size !== size) throw new Error(`LFS object ${path} did not come back.`);
  }

  return {
    transfer: options.files ? "native" : "whole-body",
    files,
    unchangedStatusChanges: status.changes.length,
    clone,
    status: statusStep,
    commit,
    push,
    createObjects,
    lfsCommit,
    lfsUpload: { ...lfsUpload, objects: pushed.uploaded, bytes: count * size },
    lfsDownload: { ...lfsDownload, objects: count, bytes: count * size },
    leftovers: `Branch ${options.remoteBranch} (two commits) and ${count} LFS objects of ${size} bytes on the host; delete the branch there. LFS storage is freed only as the host allows.`,
  };
}

import { parseRepositoryUrl } from "@haptic/source-control";
import { runGitBenchmark, type GitBenchmarkResult } from "@haptic/source-control/git-benchmark";
import { createNativeHttp, createStorage } from "@haptic/vfs";
import { sourceControlAccounts } from "../services/source-control-accounts";

export interface EditorGitBenchmarkOptions {
  /** A repository the signed-in account may push to; the benchmark pushes a new branch only. */
  repositoryUrl: string;
  branch?: string;
  /** LFS objects and their size (default 3 of 32 MiB). */
  blobs?: number;
  blobMiB?: number;
  depth?: number;
}

/**
 * Runs the Git benchmark in a scratch project folder of its own, through the
 * device's storage, native HTTP and saved credential for the repository's
 * host, then deletes the folder. Mobile only: there each storage instance
 * binds its own folder, so the open project is never touched.
 */
export async function runGitBenchmarkInEditor(options: EditorGitBenchmarkOptions): Promise<GitBenchmarkResult> {
  const location = parseRepositoryUrl(options.repositoryUrl);
  if (!location) throw new Error(`Not a repository URL: ${options.repositoryUrl}`);
  const http = createNativeHttp();
  if (!http) throw new Error("This host has no native HTTP.");
  const accounts = await sourceControlAccounts(false);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const storage = createStorage();
  const folder = await storage.openDocumentsProject(`Git Benchmark ${stamp}`);
  try {
    const result = await runGitBenchmark({
      storage,
      http,
      credential: accounts.credentialSource(location.origin),
      repositoryUrl: options.repositoryUrl,
      branch: options.branch ?? "main",
      remoteBranch: `haptic-benchmark-${stamp}`,
      author: { name: "Haptic Benchmark", email: "benchmark@haptic.invalid" },
      ...(options.blobs !== undefined || options.blobMiB !== undefined
        ? { blobs: { count: options.blobs ?? 3, size: Math.round((options.blobMiB ?? 32) * 1024 * 1024) } }
        : {}),
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
    });
    console.info(`Git benchmark\n${JSON.stringify(result, null, 2)}`);
    return result;
  } finally {
    await storage.deleteProject?.(folder);
    await storage.releaseFolder();
  }
}

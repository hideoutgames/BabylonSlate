import { isMobilePlatform } from "@haptic/vfs";
import type { GitBenchmarkResult } from "@haptic/source-control/git-benchmark";
import type { EditorGitBenchmarkOptions } from "./git-benchmark-runner";

/** LFS objects the benchmark writes, uploads and downloads again, and their size, unless asked otherwise. */
export const GIT_BENCHMARK_DEFAULT_BLOBS = 3;
export const GIT_BENCHMARK_DEFAULT_BLOB_MIB = 32;

/**
 * Where the benchmark may run: iOS and Android, where each storage instance binds its own folder, so its
 * scratch folder never touches the open project. Not on desktop, where the main process binds one folder
 * per window and a second storage instance would move the open project, nor on the web, which has no
 * native HTTP.
 */
export function gitBenchmarkAvailable(): boolean {
  return isMobilePlatform();
}

/** Loads the runner on first call; the console global and the Debug menu's dialog both run it. */
export function runGitBenchmarkLazily(options: EditorGitBenchmarkOptions): Promise<GitBenchmarkResult> {
  return import("./git-benchmark-runner").then((runner) => runner.runGitBenchmarkInEditor(options));
}

type GitBenchmarkHost = { hapticGitBenchmark?: (options: EditorGitBenchmarkOptions) => Promise<GitBenchmarkResult> };

/**
 * Debug Mode where the benchmark is available: `await hapticGitBenchmark({ repositoryUrl })` in the
 * Web Inspector console runs the Integrated mode Git benchmark (the A16 iPad gate) and prints its
 * timings. Nothing loads until it is called. Returns the uninstall.
 */
export function installGitBenchmark(): () => void {
  const host = globalThis as GitBenchmarkHost;
  host.hapticGitBenchmark = runGitBenchmarkLazily;
  return () => {
    delete host.hapticGitBenchmark;
  };
}

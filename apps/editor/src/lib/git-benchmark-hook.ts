import { isMobilePlatform } from "@haptic/vfs";
import type { GitBenchmarkStage } from "@haptic/source-control/git-benchmark";
import type { EditorGitBenchmarkOptions, EditorGitBenchmarkResult } from "./git-benchmark-runner";

/** LFS objects the benchmark writes, uploads and downloads again, and their size, unless asked otherwise. */
export const GIT_BENCHMARK_DEFAULT_BLOBS = 3;
export const GIT_BENCHMARK_DEFAULT_BLOB_MIB = 32;

/** A run's stages as the dialog names them: the benchmark's own, then the runner's removal of its scratch folder. */
export type GitBenchmarkRunStage = GitBenchmarkStage | "cleanup";

export const GIT_BENCHMARK_STAGE_LABELS: Record<GitBenchmarkRunStage, string> = {
  clone: "Clone",
  status: "Status",
  commit: "Commit",
  push: "Push",
  "create-objects": "Create LFS Objects",
  "lfs-commit": "LFS Commit",
  "lfs-upload": "LFS Upload",
  "lfs-download": "LFS Download",
  cleanup: "Clean Up",
};

/** A recorded stage's label; a stage this build does not know is shown as recorded. */
export function gitBenchmarkStageLabel(stage: string): string {
  return Object.hasOwn(GIT_BENCHMARK_STAGE_LABELS, stage) ? GIT_BENCHMARK_STAGE_LABELS[stage as GitBenchmarkRunStage] : stage;
}

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
export function runGitBenchmarkLazily(options: EditorGitBenchmarkOptions): Promise<EditorGitBenchmarkResult> {
  return import("./git-benchmark-runner").then((runner) => runner.runGitBenchmarkInEditor(options));
}

type GitBenchmarkHost = { hapticGitBenchmark?: (options: EditorGitBenchmarkOptions) => Promise<EditorGitBenchmarkResult> };

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

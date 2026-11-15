import type { EditorGitBenchmarkOptions } from "./git-benchmark-runner";

type GitBenchmarkHost = { hapticGitBenchmark?: (options: EditorGitBenchmarkOptions) => Promise<unknown> };

/**
 * Debug Mode on iOS and Android: `await hapticGitBenchmark({ repositoryUrl })` in the Web
 * Inspector console runs the Integrated mode Git benchmark (the A16 iPad gate) and prints its
 * timings. Nothing loads until it is called. Returns the uninstall.
 */
export function installGitBenchmark(): () => void {
  const host = globalThis as GitBenchmarkHost;
  host.hapticGitBenchmark = (options) => import("./git-benchmark-runner").then((runner) => runner.runGitBenchmarkInEditor(options));
  return () => {
    delete host.hapticGitBenchmark;
  };
}

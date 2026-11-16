import { parseRepositoryUrl, type FileTransferClient } from "@haptic/source-control";
import { runGitBenchmark, type GitBenchmarkResult } from "@haptic/source-control/git-benchmark";
import { createNativeFileTransfer, createNativeHttp, createStorage, folderFileTransfer, getHostMemoryStats, type HostMemoryStats } from "@haptic/vfs";
import { updateAppSettings } from "../context/app-settings-context";
import { sourceControlAccounts } from "../services/source-control-accounts";
import { GIT_BENCHMARK_DEFAULT_BLOB_MIB, GIT_BENCHMARK_DEFAULT_BLOBS, gitBenchmarkStageLabel, type GitBenchmarkRunStage } from "./git-benchmark-hook";

export interface EditorGitBenchmarkOptions {
  /** A repository the signed-in account may push to; the benchmark pushes a new branch only. */
  repositoryUrl: string;
  branch?: string;
  /** LFS objects and their size (default `GIT_BENCHMARK_DEFAULT_BLOBS` of `GIT_BENCHMARK_DEFAULT_BLOB_MIB`). */
  blobs?: number;
  blobMiB?: number;
  depth?: number;
}

/**
 * The most memory a stage was seen using, from what this host reports
 * (`getHostMemoryStats`, sampled while the stage runs): on iOS and Android
 * the app process's footprint (the WebView's content process, where
 * JavaScript runs on iOS, is not in it) and the least memory left before the
 * system would end the app; in Chromium and Electron the JavaScript heap and
 * the renderer process.
 */
export interface GitBenchmarkMemoryPeak {
  appFootprintBytes?: number;
  /** The lowest seen. */
  appAvailableBytes?: number;
  jsHeapBytes?: number;
  rendererProcessBytes?: number;
}

export interface EditorGitBenchmarkResult extends GitBenchmarkResult {
  /** Each stage's peak, for the stages the host could measure. */
  memory: Partial<Record<GitBenchmarkRunStage, GitBenchmarkMemoryPeak>>;
}

/** How often memory is sampled while a stage runs. */
const MEMORY_SAMPLE_MS = 250;

/** Samples host memory into the current stage's peak until stopped; a sample counts for the stage it began in. */
function memoryProbe(sample: () => Promise<HostMemoryStats | null>) {
  const peaks: EditorGitBenchmarkResult["memory"] = {};
  let stage: GitBenchmarkRunStage | null = null;
  let reading = false;
  const read = async () => {
    const current = stage;
    if (!current || reading) return;
    reading = true;
    try {
      const stats = await sample();
      if (!stats) return;
      const peak = (peaks[current] ??= {});
      const higher = (key: "appFootprintBytes" | "jsHeapBytes" | "rendererProcessBytes") => {
        const value = stats[key];
        if (typeof value === "number") peak[key] = Math.max(peak[key] ?? 0, value);
      };
      higher("appFootprintBytes");
      higher("jsHeapBytes");
      higher("rendererProcessBytes");
      if (typeof stats.appAvailableBytes === "number") peak.appAvailableBytes = Math.min(peak.appAvailableBytes ?? Infinity, stats.appAvailableBytes);
    } catch {
      // A host that cannot report this time reports nothing.
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => void read(), MEMORY_SAMPLE_MS);
  return {
    enter(next: GitBenchmarkRunStage) {
      stage = next;
      void read();
    },
    stop() {
      clearInterval(timer);
      return peaks;
    },
  };
}

/**
 * Records the stage a run is entering in this device's settings before it
 * starts, so a run the app does not survive (it ran out of memory) names
 * where it stopped the next time the dialog opens; `null` clears it.
 */
async function recordStage(run: { stage: GitBenchmarkRunStage; startedAt: string } | null): Promise<void> {
  await updateAppSettings((settings) => {
    settings.gitBenchmarkRun = run;
  });
}

/**
 * Runs the Git benchmark in a scratch project folder of its own, through the
 * device's storage, native HTTP, native file transfer (LFS objects stream
 * between the server and their files; the host makes the test objects) and
 * saved credential for the repository's host, then deletes the folder. Each
 * stage is recorded before it starts and its memory peak measured; the
 * record is cleared once the run ends either way. A failure names its stage.
 * Mobile only: there each storage instance binds its own folder, so the open
 * project is never touched.
 */
export async function runGitBenchmarkInEditor(options: EditorGitBenchmarkOptions): Promise<EditorGitBenchmarkResult> {
  const location = parseRepositoryUrl(options.repositoryUrl);
  if (!location) throw new Error(`Not a repository URL: ${options.repositoryUrl}`);
  const http = createNativeHttp();
  if (!http) throw new Error("This host has no native HTTP.");
  const accounts = await sourceControlAccounts(false);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[^0-9]/g, "").slice(0, 14);
  const storage = createStorage();
  const folder = await storage.openDocumentsProject(`Git Benchmark ${stamp}`);
  const native = createNativeFileTransfer();
  const transfer = native ? folderFileTransfer(native, storage) : null;
  const files: FileTransferClient | undefined = transfer ? (request) => transfer.transfer(request) : undefined;
  const memory = memoryProbe(getHostMemoryStats);
  let stage: GitBenchmarkRunStage | null = null;
  const enter = async (next: GitBenchmarkRunStage) => {
    stage = next;
    memory.enter(next);
    await recordStage({ stage: next, startedAt });
  };
  try {
    const result = await runGitBenchmark({
      storage,
      http,
      ...(files ? { files } : {}),
      ...(transfer?.writeRandomObject ? { writeRandomObject: transfer.writeRandomObject } : {}),
      credential: accounts.credentialSource(location.origin),
      repositoryUrl: options.repositoryUrl,
      branch: options.branch ?? "main",
      remoteBranch: `haptic-benchmark-${stamp}`,
      author: { name: "Haptic Benchmark", email: "benchmark@haptic.invalid" },
      blobs: {
        count: options.blobs ?? GIT_BENCHMARK_DEFAULT_BLOBS,
        size: Math.round((options.blobMiB ?? GIT_BENCHMARK_DEFAULT_BLOB_MIB) * 1024 * 1024),
      },
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      onStage: enter,
    });
    await enter("cleanup");
    await storage.deleteProject?.(folder);
    const done: EditorGitBenchmarkResult = { ...result, memory: memory.stop() };
    console.info(`Git benchmark\n${JSON.stringify(done, null, 2)}`);
    return done;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stage ? `Stopped during ${gitBenchmarkStageLabel(stage)}: ${message}` : message, { cause: error });
  } finally {
    memory.stop();
    if (stage !== "cleanup") await storage.deleteProject?.(folder).catch(() => undefined);
    await storage.releaseFolder();
    await recordStage(null).catch(() => undefined);
  }
}
